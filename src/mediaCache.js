import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';
import { bot } from './runtime.js';

let stopped = false;
let workerPromise = null;
let processedThisProcess = 0;
let lastError = null;
let lastCachedAt = null;

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

async function claimNext(db) {
  const { rows } = await db.query(`
    WITH picked AS (
      SELECT source_url
      FROM media_images
      WHERE
        status = 'pending'
        OR (status = 'retry' AND COALESCE(next_attempt_at, now()) <= now())
        OR (status = 'processing' AND updated_at < now() - interval '15 minutes')
      ORDER BY
        CASE WHEN usage_types ? 'artist_image' THEN 0
             WHEN usage_types ? 'album_cover' THEN 1
             ELSE 2 END,
        source_url
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
  `);
  return rows[0] || null;
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

async function markFailed(db, row, err) {
  const terminal = Number(row.attempts || 0) >= 3;
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

  console.log('[media cache] worker started');
  while (!stopped && config.mediaCacheEnabled) {
    let row;
    try {
      row = await claimNext(db);
      if (!row) {
        await sleep(30_000);
        continue;
      }

      const message = await bot.sendPhoto(config.mediaCacheChatId, row.source_url, {
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
        try { await markFailed(db, row, err); } catch (markErr) {
          console.error('[media cache mark failed]', markErr?.message || markErr);
        }
      }
    }

    await sleep(config.mediaCacheDelayMs);
  }
  console.log('[media cache] worker stopped');
}

export function startMediaCacheWorker() {
  if (!config.mediaCacheEnabled || workerPromise) return workerPromise;
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
    running: Boolean(workerPromise) && !stopped,
    processedThisProcess,
    lastCachedAt,
    lastError,
  };
}
