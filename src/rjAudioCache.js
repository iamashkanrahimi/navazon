import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';
import { BotApi } from './botApi.js';
import { FileCache } from './cache.js';
import { DeepCatalog } from './deepCatalog.js';
import { getRjExtraCacheLanes } from './rjCacheLanes.js';
import {
  artistCreditCompatible,
  crossScriptIdentityCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const bot = new BotApi(config.botToken);
const productionCache = new FileCache();
const productionDeepCatalog = new DeepCatalog();

let stopped = false;
let workerPromise = null;
let processedThisProcess = 0;
let cachedThisProcess = 0;
let failedThisProcess = 0;
let rateLimitedThisProcess = 0;
let lastCachedAt = null;
let lastError = null;
let floodBackoffUntil = null;
let activeLaneSummary = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createLaneScheduler(lanes = []) {
  let chain = Promise.resolve();
  let globalNotBefore = 0;

  async function acquireLane() {
    let selected = null;
    const scheduled = chain.then(async () => {
      selected = lanes.reduce((best, lane) => {
        if (!best) return lane;
        return Number(lane.nextStartAt || 0) < Number(best.nextStartAt || 0)
          ? lane
          : best;
      }, null);
      if (!selected) throw new Error('No Telegram cache lane available');

      while (true) {
        const waitUntil = Math.max(
          Number(selected.nextStartAt || 0),
          Number(globalNotBefore || 0)
        );
        const waitMs = Math.max(0, waitUntil - Date.now());
        if (waitMs > 0) await sleep(waitMs);

        // A Telegram 429 can extend the global gate while this acquire is
        // already sleeping. Re-check before handing the lane to a worker.
        if (Date.now() < globalNotBefore) continue;
        break;
      }

      selected.nextStartAt = Date.now() + selected.intervalMs;
    });

    chain = scheduled.catch(() => {});
    await scheduled;
    return selected;
  }

  function deferAll(retryAfterSeconds = 1) {
    const delayMs = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1)) * 1000 + 1500;
    const until = Date.now() + delayMs;
    globalNotBefore = Math.max(globalNotBefore, until);
    for (const lane of lanes) {
      lane.nextStartAt = Math.max(Number(lane.nextStartAt || 0), globalNotBefore);
    }
    return globalNotBefore;
  }

  return {
    acquireLane,
    deferAll,
    getBackoffUntil: () => globalNotBefore,
  };
}

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function retryAfterSeconds(err) {
  if (Number(err?.code) !== 429) return null;
  const value = Number(err?.parameters?.retry_after || 1);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

export function directCandidates(slug = '', sourceId = '') {
  const encoded = encodeURIComponent(clean(slug));
  if (!encoded) return [];

  const numericId = /^\d+$/.test(String(sourceId || '').trim())
    ? Number(sourceId)
    : null;

  // The live archive sample has a clean host boundary around source_id 72k:
  // older IDs resolve on host1 and newer IDs on host2. This is only a
  // priority hint; the opposite host remains an immediate fallback.
  const preferredHost = numericId && numericId < 72500 ? 'host1' : 'host2';
  const alternateHost = preferredHost === 'host1' ? 'host2' : 'host1';

  return [
    { quality: 320, host: preferredHost, url: `https://${preferredHost}.rj-mw1.com/media/mp3/mp3-320/${encoded}.mp3` },
    { quality: 320, host: alternateHost, url: `https://${alternateHost}.rj-mw1.com/media/mp3/mp3-320/${encoded}.mp3` },
    { quality: 256, host: preferredHost, url: `https://${preferredHost}.rj-mw1.com/media/mp3/mp3-256/${encoded}.mp3` },
    { quality: 256, host: alternateHost, url: `https://${alternateHost}.rj-mw1.com/media/mp3/mp3-256/${encoded}.mp3` },
  ];
}

export function verifyTelegramAudio(row, message) {
  const audio = message?.audio || null;
  if (!audio?.file_id) {
    return { ok: false, reason: 'Telegram sendAudio returned no audio.file_id', audio: null };
  }

  const expectedDuration = Number(row.expected_duration_seconds || 0) || null;
  const actualDuration = Number(audio.duration || 0) || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;

  const title = clean(audio.title);
  const performer = clean(audio.performer);
  const titleOk = title
    ? trackTitleIdentityCompatible(row.title, title)
    : null;
  const artistOk = performer
    ? (
        artistCreditCompatible(row.artist, performer)
        || crossScriptIdentityCompatible(row.artist, performer)
      )
    : null;

  const textContradictions = [titleOk, artistOk].filter(value => value === false);
  const hasTextEvidence = titleOk === true || artistOk === true;
  const hasTightDurationEvidence = Boolean(
    expectedDuration
    && actualDuration
    && durationDelta != null
    && durationDelta <= 3
  );
  const hasIdentityEvidence = hasTextEvidence || hasTightDurationEvidence;
  const ok = durationOk
    && textContradictions.length === 0
    && hasIdentityEvidence;

  let reason = null;
  if (!durationOk) {
    reason = `duration mismatch: expected=${expectedDuration} actual=${actualDuration}`;
  } else if (titleOk === false && artistOk === false) {
    reason = 'embedded title and performer contradict Radio Javan identity';
  } else if (titleOk === false) {
    reason = 'embedded title contradicts Radio Javan identity';
  } else if (artistOk === false) {
    reason = 'embedded performer contradicts Radio Javan identity';
  } else if (!hasIdentityEvidence) {
    reason = 'insufficient Radio Javan identity evidence';
  }

  return {
    ok,
    reason,
    audio,
    expectedDuration,
    actualDuration,
    durationDelta,
    titleOk,
    artistOk,
  };
}

export async function ensureRjAudioCacheSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rj_audio_cache (
      source_url TEXT PRIMARY KEY,
      source_id TEXT,
      source_slug TEXT NOT NULL,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      expected_duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      direct_url TEXT,
      direct_quality INTEGER,
      direct_host TEXT,
      telegram_file_id TEXT,
      telegram_file_unique_id TEXT,
      telegram_message_id BIGINT,
      telegram_chat_id TEXT,
      file_size BIGINT,
      actual_duration_seconds INTEGER,
      observed_title TEXT,
      observed_performer TEXT,
      verification JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error TEXT,
      next_attempt_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      cached_at TIMESTAMPTZ,
      canonicalized_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE rj_audio_cache
      ADD COLUMN IF NOT EXISTS canonicalized_at TIMESTAMPTZ;
    ALTER TABLE rj_audio_cache
      ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;

    CREATE INDEX IF NOT EXISTS rj_audio_cache_status_idx
      ON rj_audio_cache (status, next_attempt_at, updated_at);
  `);

  await db.query(`
    INSERT INTO rj_audio_cache (
      source_url, source_id, source_slug, artist, title, expected_duration_seconds
    )
    SELECT
      source_url,
      source_id,
      source_slug,
      artist_display,
      title,
      CASE
        WHEN duration_seconds IS NULL THEN NULL
        ELSE ROUND(duration_seconds)::int
      END
    FROM rj_tracks
    WHERE NULLIF(BTRIM(COALESCE(source_url,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(source_slug,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(artist_display,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(title,'')), '') IS NOT NULL
    ON CONFLICT (source_url) DO UPDATE SET
      source_id=EXCLUDED.source_id,
      source_slug=EXCLUDED.source_slug,
      artist=EXCLUDED.artist,
      title=EXCLUDED.title,
      expected_duration_seconds=EXCLUDED.expected_duration_seconds
  `);
}

async function claimNext(db) {
  const { rows } = await db.query(`
    WITH picked AS (
      SELECT source_url
      FROM rj_audio_cache
      WHERE attempts < $1
        AND (
          status='pending'
          OR (status='retry' AND COALESCE(next_attempt_at, NOW()) <= NOW())
          OR (status='processing' AND updated_at < NOW() - INTERVAL '15 minutes')
        )
      ORDER BY
        CASE WHEN status='pending' THEN 0 ELSE 1 END,
        md5(source_url || ':rj-direct-audio-v1')
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE rj_audio_cache c
       SET status='processing',
           attempts=c.attempts+1,
           started_at=NOW(),
           last_error=NULL,
           updated_at=NOW()
      FROM picked
     WHERE c.source_url=picked.source_url
    RETURNING c.*
  `, [config.rjAudioCacheMaxAttempts]);
  return rows[0] || null;
}

export async function writeCanonicalProduction(
  row,
  candidate,
  audio,
  { acquisition = 'radiojavan_direct' } = {}
) {
  const track = {
    artist: row.artist,
    title: row.title,
    source: 'radiojavan',
    rawText: row.source_url,
  };
  const media = {
    kind: 'audio',
    fileId: audio.file_id || audio.fileId,
    fileUniqueId: audio.file_unique_id || audio.fileUniqueId || null,
    title: row.title,
    performer: row.artist,
    duration: Number(audio.duration || audio.actual_duration_seconds || 0) || null,
    fileSize: Number(audio.file_size || audio.fileSize || 0) || null,
    bitrate: Number(candidate.quality || row.direct_quality || 0) || null,
    directUrl: candidate.url || row.direct_url || null,
    verifiedDirect: true,
    acquisition,
  };

  if (!media.fileId) throw new Error('Radio Javan canonical media missing file_id');

  await productionCache.set(track, media, { sourceFetch: true });
  await productionDeepCatalog.setMedia(track, 'hq', media, {
    source: 'radiojavan',
    bitrate: media.bitrate || undefined,
    fileSize: media.fileSize || undefined,
    satisfiedBy: acquisition,
  });
}

async function syncExistingCanonicalRows(db) {
  let synced = 0;
  while (true) {
    const { rows } = await db.query(`
      SELECT *
      FROM rj_audio_cache
      WHERE status='cached'
        AND telegram_file_id IS NOT NULL
        AND canonicalized_at IS NULL
      ORDER BY cached_at NULLS LAST, source_url
      LIMIT 250
    `);
    if (!rows.length) break;

    for (const row of rows) {
      try {
        await writeCanonicalProduction(row, {
          quality: row.direct_quality,
          url: row.direct_url,
        }, {
          file_id: row.telegram_file_id,
          file_unique_id: row.telegram_file_unique_id,
          file_size: row.file_size,
          duration: row.actual_duration_seconds,
        });
        await db.query(
          'UPDATE rj_audio_cache SET canonicalized_at=NOW(), updated_at=NOW() WHERE source_url=$1',
          [row.source_url]
        );
        synced += 1;
      } catch (err) {
        console.warn('[rj audio cache canonical sync]', row.artist, row.title, err.message);
        return synced;
      }
    }
  }
  if (synced) console.log('[rj audio cache] canonical backfill', synced);
  return synced;
}

export async function markRjAudioCached(
  db,
  row,
  candidate,
  message,
  verification,
  {
    retainMessage = true,
    chatId = null,
    acquisition = 'radiojavan_direct',
  } = {}
) {
  const audio = verification.audio;
  await writeCanonicalProduction(row, candidate, audio, { acquisition });
  await db.query(`
    UPDATE rj_audio_cache
       SET status='cached',
           direct_url=$2,
           direct_quality=$3,
           direct_host=$4,
           telegram_file_id=$5,
           telegram_file_unique_id=$6,
           telegram_message_id=$7,
           telegram_chat_id=$8,
           file_size=$9,
           actual_duration_seconds=$10,
           observed_title=$11,
           observed_performer=$12,
           verification=$13::jsonb,
           last_error=NULL,
           next_attempt_at=NULL,
           cached_at=NOW(),
           canonicalized_at=NOW(),
           updated_at=NOW()
     WHERE source_url=$1
  `, [
    row.source_url,
    candidate.url,
    candidate.quality,
    candidate.host,
    audio.file_id,
    audio.file_unique_id || null,
    retainMessage ? (message.message_id || null) : null,
    retainMessage ? String(chatId || '') || null : null,
    Number(audio.file_size || 0) || null,
    Number(audio.duration || 0) || null,
    clean(audio.title) || null,
    clean(audio.performer) || null,
    JSON.stringify({
      durationDelta: verification.durationDelta,
      titleOk: verification.titleOk,
      artistOk: verification.artistOk,
      expectedDuration: verification.expectedDuration,
      actualDuration: verification.actualDuration,
      acquisition,
    }),
  ]);

}

export async function markRjAudioFailure(
  db,
  row,
  errors,
  { rateLimited = false, retryAfter = null } = {}
) {
  const message = errors.filter(Boolean).join(' | ').slice(0, 1800) || 'No direct URL candidate succeeded';

  if (rateLimited) {
    const delaySeconds = Math.max(5, Math.ceil(Number(retryAfter) || 1) + 3);
    await db.query(`
      UPDATE rj_audio_cache
         SET status='retry',
             attempts=GREATEST(attempts-1, 0),
             last_error=$2,
             next_attempt_at=NOW() + ($3::int * INTERVAL '1 second'),
             updated_at=NOW()
       WHERE source_url=$1
    `, [row.source_url, message, delaySeconds]);
    return;
  }

  const terminal = Number(row.attempts || 0) >= config.rjAudioCacheMaxAttempts;
  await db.query(`
    UPDATE rj_audio_cache
       SET status=$2,
           last_error=$3,
           next_attempt_at=CASE WHEN $2='retry' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
           updated_at=NOW()
     WHERE source_url=$1
  `, [row.source_url, terminal ? 'failed' : 'retry', message]);
}

async function progress(db) {
  const { rows } = await db.query(`
    SELECT status, COUNT(*)::int AS n
    FROM rj_audio_cache
    GROUP BY status
    ORDER BY status
  `);
  const summary = Object.fromEntries(rows.map(row => [row.status, row.n]));
  console.log('[rj audio cache] progress', JSON.stringify(summary));
  return summary;
}

async function processRow(db, row, laneScheduler) {
  const errors = [];
  for (const candidate of directCandidates(row.source_slug, row.source_id)) {
    let message = null;
    let lane = null;
    try {
      lane = await laneScheduler.acquireLane();
      message = await bot.sendAudio(
        lane.chatId,
        candidate.url,
        { disable_notification: true },
        // Surface 429 immediately. The RJ scheduler owns the long flood wait
        // so all lanes pause together instead of each worker retrying early.
        { max429WaitSeconds: 0 }
      );
      const verification = verifyTelegramAudio(row, message);
      if (!verification.ok) {
        errors.push(`${candidate.host}/${candidate.quality}: ${verification.reason}`);
        if (message?.message_id) {
          await bot.deleteMessage(lane.chatId, message.message_id).catch(() => null);
        }
        continue;
      }

      await markRjAudioCached(db, row, candidate, message, verification, {
        retainMessage: !lane.ephemeral,
        chatId: lane.chatId,
      });

      if (lane.ephemeral && message?.message_id) {
        await bot.deleteMessage(lane.chatId, message.message_id).catch(err => {
          console.warn('[rj audio cache] ephemeral cleanup', lane.name, err.message);
        });
      }

      return {
        ok: true,
        candidate,
        lane: lane.name,
        fileId: verification.audio.file_id,
        duration: verification.actualDuration,
      };
    } catch (err) {
      const retryAfter = retryAfterSeconds(err);
      errors.push(`${candidate.host}/${candidate.quality}: ${String(err?.message || err).slice(0, 350)}`);

      if (message?.message_id && lane) {
        await bot.deleteMessage(lane.chatId, message.message_id).catch(() => null);
      }

      if (retryAfter != null) {
        const backoffUntilMs = laneScheduler.deferAll(retryAfter);
        floodBackoffUntil = new Date(backoffUntilMs).toISOString();
        await markRjAudioFailure(db, row, errors, {
          rateLimited: true,
          retryAfter,
        });
        return {
          ok: false,
          rateLimited: true,
          retryAfter,
          backoffUntil: floodBackoffUntil,
          errors,
        };
      }
    }
  }

  await markRjAudioFailure(db, row, errors);
  return { ok: false, rateLimited: false, errors };
}

async function workerLoop(archiveDb, workerId, laneScheduler) {
  while (!stopped && config.rjAudioCacheEnabled) {
    let row = null;
    try {
      row = await claimNext(archiveDb);
      if (!row) {
        await sleep(5_000);
        continue;
      }

      const result = await processRow(archiveDb, row, laneScheduler);
      processedThisProcess += 1;
      if (result.ok) {
        cachedThisProcess += 1;
        lastCachedAt = new Date().toISOString();
        lastError = null;
        console.log('[rj audio cache] cached', JSON.stringify({
          workerId,
          artist: row.artist,
          title: row.title,
          quality: result.candidate.quality,
          host: result.candidate.host,
          duration: result.duration,
          lane: result.lane,
        }));
      } else if (result.rateLimited) {
        rateLimitedThisProcess += 1;
        lastError = result.errors?.[result.errors.length - 1] || 'telegram rate limit';
        console.warn('[rj audio cache] rate limited', JSON.stringify({
          workerId,
          artist: row.artist,
          title: row.title,
          retryAfter: result.retryAfter,
          backoffUntil: result.backoffUntil,
        }));
      } else {
        failedThisProcess += 1;
        lastError = result.errors?.[result.errors.length - 1] || 'direct URL failure';
        console.warn('[rj audio cache] miss', JSON.stringify({
          workerId,
          artist: row.artist,
          title: row.title,
          attempts: row.attempts,
          error: lastError,
        }));
      }

      if (processedThisProcess > 0 && processedThisProcess % 250 === 0) {
        await progress(archiveDb);
      }
    } catch (err) {
      lastError = String(err?.message || err);
      console.error('[rj audio cache]', workerId, lastError);
      if (row) {
        try { await markRjAudioFailure(archiveDb, row, [lastError]); } catch (markErr) {
          console.error('[rj audio cache mark failure]', markErr?.message || markErr);
        }
      }
    }
  }
}

async function loop() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    console.warn('[rj audio cache] ARCHIVE_DATABASE_URL missing; worker disabled');
    return;
  }
  if (!config.mediaCacheChatId) {
    console.warn('[rj audio cache] MEDIA_CACHE_CHAT_ID missing; worker disabled');
    return;
  }

  await ensureRjAudioCacheSchema(archiveDb);

  await syncExistingCanonicalRows(archiveDb);
  const initial = await progress(archiveDb);

  const extraLanes = await getRjExtraCacheLanes();
  const laneSpecs = [
    {
      name: 'cache',
      chatId: String(config.mediaCacheChatId),
      ephemeral: false,
    },
    {
      name: 'proxy-private',
      chatId: String(config.proxyUserId || ''),
      ephemeral: true,
    },
    ...extraLanes.map((lane, index) => ({
      name: lane?.name || `extra-${index + 1}`,
      chatId: String(lane?.chatId || ''),
      ephemeral: false,
    })),
  ].filter((lane, index, all) =>
    lane.chatId
    && all.findIndex(other => other.chatId === lane.chatId) === index
  );

  const lanes = [];
  for (const spec of laneSpecs) {
    try {
      const chatType = String((await bot.getChat(spec.chatId))?.type || 'unknown');
      const groupLike = (
        chatType === 'group'
        || chatType === 'supergroup'
        || chatType === 'channel'
      );
      const intervalMs = groupLike
        ? 3100
        : Math.max(1100, config.rjAudioCacheSendIntervalMs);
      lanes.push({
        ...spec,
        chatType,
        intervalMs,
        nextStartAt: 0,
      });
    } catch (err) {
      console.warn('[rj audio cache] lane unavailable', spec.name, err.message);
    }
  }

  if (!lanes.length) {
    throw new Error('No usable Telegram cache lanes');
  }

  activeLaneSummary = lanes.map(lane => ({
    name: lane.name,
    chatType: lane.chatType,
    intervalMs: lane.intervalMs,
    ephemeral: lane.ephemeral,
  }));

  const laneScheduler = createLaneScheduler(lanes);
  const concurrency = Math.max(config.rjAudioCacheConcurrency, lanes.length * 6);

  console.log('[rj audio cache] worker started', JSON.stringify({
    total: Object.values(initial).reduce((sum, value) => sum + Number(value || 0), 0),
    concurrency,
    lanes: activeLaneSummary,
    maxAttempts: config.rjAudioCacheMaxAttempts,
  }));

  await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      workerLoop(archiveDb, index + 1, laneScheduler)
    )
  );

  console.log('[rj audio cache] worker stopped');
}

export function startRjAudioCacheWorker() {
  if (!config.rjAudioCacheEnabled || workerPromise) return workerPromise;
  stopped = false;
  workerPromise = loop().finally(() => { workerPromise = null; });
  return workerPromise;
}

export function stopRjAudioCacheWorker() {
  stopped = true;
}

export function getRjAudioCacheRuntimeStatus() {
  return {
    enabled: config.rjAudioCacheEnabled,
    running: Boolean(workerPromise) && !stopped,
    processedThisProcess,
    cachedThisProcess,
    failedThisProcess,
    rateLimitedThisProcess,
    floodBackoffUntil,
    floodBackoffActive: Boolean(
      floodBackoffUntil && Date.parse(floodBackoffUntil) > Date.now()
    ),
    concurrency: config.rjAudioCacheConcurrency,
    sendIntervalMs: config.rjAudioCacheSendIntervalMs,
    lanes: activeLaneSummary,
    lastCachedAt,
    lastError,
  };
}

export async function getRjAudioCacheSummary() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) return { enabled: false, reason: 'archive_db_missing' };
  await ensureRjAudioCacheSchema(archiveDb);
  const { rows } = await archiveDb.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='processing')::int AS processing,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='cached')::int AS cached,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='cached' AND direct_quality=320)::int AS cached_320,
      COUNT(*) FILTER (WHERE status='cached' AND direct_quality=256)::int AS cached_256,
      COUNT(*) FILTER (WHERE status='cached' AND canonicalized_at IS NOT NULL)::int AS canonicalized,
      MAX(cached_at) AS latest_cached_at
    FROM rj_audio_cache
  `);
  return rows[0] || {};
}
