import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';
import { BotApi } from './botApi.js';

const bot = new BotApi(config.botToken);

let stopped = false;
let workerPromise = null;
let processedThisProcess = 0;
let lastError = null;
let lastCachedAt = null;
let waitingForAudio = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function pickBestPhoto(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  return photos.reduce((best, p) => {
    if (!best) return p;
    const score = Number(p.width || 0) * Number(p.height || 0);
    const bestScore = Number(best.width || 0) * Number(best.height || 0);
    if (score !== bestScore) return score > bestScore ? p : best;
    return Number(p.file_size || 0) > Number(best.file_size || 0) ? p : best;
  }, null);
}

async function claimNext(db, { recoveryOnly = false } = {}) {
  const { rows } = await db.query(`
    WITH picked AS (
      SELECT source_url
      FROM media_images m
      WHERE (
        (
          $1::boolean
          AND m.status = 'failed'
          AND m.attempts < 4
        )
        OR (
          NOT $1::boolean
          AND (
            m.status = 'pending'
            OR (m.status = 'retry' AND COALESCE(m.next_attempt_at, now()) <= now())
            OR (m.status = 'processing' AND m.updated_at < now() - interval '15 minutes')
          )
        )
      )
      AND (
        EXISTS (
          SELECT 1
          FROM rj_artists a
          WHERE a.image_url = m.source_url
            AND a.image_kind = 'artist_profile'
        )
        OR m.usage_types ? 'album_cover'
        OR m.usage_types ? 'track_cover'
      )
      ORDER BY
        CASE WHEN EXISTS (
          SELECT 1
          FROM rj_artists a
          WHERE a.image_url = m.source_url
            AND a.image_kind = 'artist_profile'
        ) THEN 0
             WHEN m.usage_types ? 'album_cover' THEN 1
             ELSE 2 END,
        m.source_url
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE media_images m
       SET status='processing',
           attempts=m.attempts+1,
           updated_at=now()
      FROM picked
     WHERE m.source_url=picked.source_url
    RETURNING m.*
  `, [Boolean(recoveryOnly)]);
  return rows[0] || null;
}

async function audioCacheHasWork(db) {
  try {
    const { rows } = await db.query(`
      SELECT EXISTS (
        SELECT 1
        FROM rj_audio_cache
        WHERE status IN ('pending', 'processing', 'retry')
        LIMIT 1
      ) AS busy
    `);
    return Boolean(rows[0]?.busy);
  } catch (err) {
    console.warn('[media cache recovery] audio status unavailable', err?.message || err);
    return true;
  }
}

function imageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

async function fetchImageForUpload(sourceUrl) {
  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      accept: 'image/*,*/*;q=0.5',
      'user-agent': 'NavazonMediaRecovery/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`image fetch HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('image fetch returned empty body');
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error(`image fetch too large: ${buffer.length}`);
  }

  const kind = imageKind(buffer);
  if (!kind) {
    const contentType = response.headers.get('content-type') || 'unknown';
    throw new Error(`image fetch returned unsupported content: ${contentType}`);
  }

  return {
    buffer,
    filename: `navazon-recovery.${kind.ext}`,
  };
}

async function recoverPhoto(row) {
  const fetched = await fetchImageForUpload(row.source_url);
  return bot.sendPhotoBuffer(
    config.mediaCacheChatId,
    fetched.buffer,
    fetched.filename,
    { disable_notification: true },
    { max429WaitSeconds: 0 }
  );
}

async function markCached(db, row, message, photo) {
  await db.query(`
    UPDATE media_images
       SET status='cached',
           telegram_file_id=$2,
           telegram_file_unique_id=$3,
           width=$4,
           height=$5,
           file_size=$6,
           telegram_message_id=$7,
           cached_at=now(),
           next_attempt_at=NULL,
           last_error=NULL,
           updated_at=now()
     WHERE source_url=$1
  `, [
    row.source_url,
    photo.file_id,
    photo.file_unique_id || null,
    photo.width || null,
    photo.height || null,
    photo.file_size || null,
    message.message_id || null,
  ]);
}

async function markFailed(db, row, err, { recoveryOnly = false } = {}) {
  const retryAfter = Number(err?.code) === 429
    ? Math.max(1, Number(err?.parameters?.retry_after || 1))
    : null;

  if (retryAfter != null) {
    await db.query(`
      UPDATE media_images
         SET status='retry',
             attempts=GREATEST(attempts-1, 0),
             last_error=$2,
             next_attempt_at=now() + ($3::int * interval '1 second'),
             updated_at=now()
       WHERE source_url=$1
    `, [
      row.source_url,
      String(err?.message || err).slice(0, 1000),
      Math.ceil(retryAfter) + 3,
    ]);
    return;
  }

  const maxAttempts = recoveryOnly ? 4 : 3;
  const terminal = Number(row.attempts || 0) >= maxAttempts;
  await db.query(`
    UPDATE media_images
       SET status=$2,
           last_error=$3,
           next_attempt_at=CASE WHEN $2='retry' THEN now() + interval '10 minutes' ELSE NULL END,
           updated_at=now()
     WHERE source_url=$1
  `, [row.source_url, terminal ? 'failed' : 'retry', String(err?.message || err).slice(0, 1000)]);
}

async function logProgress(db) {
  const { rows } = await db.query(`
    SELECT status, count(*)::int AS count
    FROM media_images
    GROUP BY status
    ORDER BY status
  `);
  console.log('[media cache] progress', JSON.stringify(Object.fromEntries(rows.map(r => [r.status, r.count]))));
}

async function loop() {
  const db = getArchiveDb();
  if (!db) {
    console.warn('[media cache] ARCHIVE_DATABASE_URL missing; worker disabled');
    return;
  }
  if (!config.mediaCacheChatId) {
    console.warn('[media cache] MEDIA_CACHE_CHAT_ID missing; worker disabled');
    return;
  }

  const recoveryOnly = !config.mediaCacheEnabled && config.mediaCacheRecoveryEnabled;
  console.log('[media cache] worker started', JSON.stringify({
    mode: recoveryOnly ? 'deferred-recovery' : 'normal',
  }));

  while (!stopped && (config.mediaCacheEnabled || config.mediaCacheRecoveryEnabled)) {
    let row;
    try {
      if (recoveryOnly) {
        waitingForAudio = await audioCacheHasWork(db);
        if (waitingForAudio) {
          await sleep(60_000);
          continue;
        }
        waitingForAudio = false;
      }

      row = await claimNext(db, { recoveryOnly });
      if (!row) {
        if (recoveryOnly) {
          console.log('[media cache recovery] complete');
          break;
        }
        await sleep(30_000);
        continue;
      }

      const message = recoveryOnly
        ? await recoverPhoto(row)
        : await bot.sendPhoto(config.mediaCacheChatId, row.source_url, {
            disable_notification: true,
          });
      const photo = pickBestPhoto(message);
      if (!photo?.file_id) throw new Error('Telegram sendPhoto returned no PhotoSize');
      await markCached(db, row, message, photo);

      processedThisProcess += 1;
      lastCachedAt = new Date().toISOString();
      lastError = null;
      if (processedThisProcess % 100 === 0) await logProgress(db);
    } catch (err) {
      lastError = String(err?.message || err);
      console.warn('[media cache]', lastError);
      if (row) {
        try { await markFailed(db, row, err, { recoveryOnly }); } catch (markErr) {
          console.error('[media cache mark failed]', markErr?.message || markErr);
        }
      }
    }

    await sleep(config.mediaCacheDelayMs);
  }
  console.log('[media cache] worker stopped');
}

export function startMediaCacheWorker() {
  if ((!config.mediaCacheEnabled && !config.mediaCacheRecoveryEnabled) || workerPromise) {
    return workerPromise;
  }
  stopped = false;
  workerPromise = loop().finally(() => { workerPromise = null; });
  return workerPromise;
}

export function stopMediaCacheWorker() {
  stopped = true;
}

export function getMediaCacheRuntimeStatus() {
  return {
    enabled: config.mediaCacheEnabled,
    recoveryEnabled: config.mediaCacheRecoveryEnabled,
    recoveryOnly: !config.mediaCacheEnabled && config.mediaCacheRecoveryEnabled,
    waitingForAudio,
    running: Boolean(workerPromise) && !stopped,
    processedThisProcess,
    lastCachedAt,
    lastError,
  };
}
