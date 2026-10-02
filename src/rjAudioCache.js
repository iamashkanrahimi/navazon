import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';
import { BotApi } from './botApi.js';
import { FileCache } from './cache.js';
import { DeepCatalog } from './deepCatalog.js';
import {
  artistCreditCompatible,
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
let lastCachedAt = null;
let lastError = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function directCandidates(slug = '') {
  const encoded = encodeURIComponent(clean(slug));
  if (!encoded) return [];
  return [
    { quality: 320, host: 'host2', url: `https://host2.rj-mw1.com/media/mp3/mp3-320/${encoded}.mp3` },
    { quality: 320, host: 'host1', url: `https://host1.rj-mw1.com/media/mp3/mp3-320/${encoded}.mp3` },
    { quality: 256, host: 'host2', url: `https://host2.rj-mw1.com/media/mp3/mp3-256/${encoded}.mp3` },
    { quality: 256, host: 'host1', url: `https://host1.rj-mw1.com/media/mp3/mp3-256/${encoded}.mp3` },
  ];
}

function verifyTelegramAudio(row, message) {
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
    ? artistCreditCompatible(row.artist, performer)
    : null;

  const textContradictions = [titleOk, artistOk].filter(value => value === false).length;
  const ok = durationOk && textContradictions < 2;

  return {
    ok,
    reason: ok
      ? null
      : (!durationOk
          ? `duration mismatch: expected=${expectedDuration} actual=${actualDuration}`
          : 'embedded title and performer both contradict Radio Javan identity'),
    audio,
    expectedDuration,
    actualDuration,
    durationDelta,
    titleOk,
    artistOk,
  };
}

async function ensureSchema(db) {
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

async function writeCanonicalProduction(row, candidate, audio) {
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
    acquisition: 'radiojavan_direct',
  };

  if (!media.fileId) throw new Error('Radio Javan canonical media missing file_id');

  await productionCache.set(track, media, { sourceFetch: true });
  await productionDeepCatalog.setMedia(track, 'hq', media, {
    source: 'radiojavan',
    bitrate: media.bitrate || undefined,
    fileSize: media.fileSize || undefined,
    satisfiedBy: 'radiojavan_direct',
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

async function markCached(db, row, candidate, message, verification) {
  const audio = verification.audio;
  await writeCanonicalProduction(row, candidate, audio);
  await db.query(`
    UPDATE rj_audio_cache
       SET status='cached',
           direct_url=$2,
           direct_quality=$3,
           direct_host=$4,
           telegram_file_id=$5,
           telegram_file_unique_id=$6,
           telegram_message_id=$7,
           file_size=$8,
           actual_duration_seconds=$9,
           observed_title=$10,
           observed_performer=$11,
           verification=$12::jsonb,
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
    message.message_id || null,
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
    }),
  ]);

}

async function markFailure(db, row, errors) {
  const terminal = Number(row.attempts || 0) >= config.rjAudioCacheMaxAttempts;
  const message = errors.filter(Boolean).join(' | ').slice(0, 1800) || 'No direct URL candidate succeeded';
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

async function processRow(db, row) {
  const errors = [];
  for (const candidate of directCandidates(row.source_slug)) {
    let message = null;
    try {
      message = await bot.sendAudio(config.mediaCacheChatId, candidate.url, {
        disable_notification: true,
      });
      const verification = verifyTelegramAudio(row, message);
      if (!verification.ok) {
        errors.push(`${candidate.host}/${candidate.quality}: ${verification.reason}`);
        if (message?.message_id) {
          await bot.deleteMessage(config.mediaCacheChatId, message.message_id).catch(() => null);
        }
        continue;
      }

      await markCached(db, row, candidate, message, verification);
      return {
        ok: true,
        candidate,
        fileId: verification.audio.file_id,
        duration: verification.actualDuration,
      };
    } catch (err) {
      errors.push(`${candidate.host}/${candidate.quality}: ${String(err?.message || err).slice(0, 350)}`);
      if (message?.message_id) {
        await bot.deleteMessage(config.mediaCacheChatId, message.message_id).catch(() => null);
      }
    }
  }

  await markFailure(db, row, errors);
  return { ok: false, errors };
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

  await ensureSchema(archiveDb);
  await syncExistingCanonicalRows(archiveDb);
  const initial = await progress(archiveDb);
  console.log('[rj audio cache] worker started', JSON.stringify({
    total: Object.values(initial).reduce((sum, value) => sum + Number(value || 0), 0),
    delayMs: config.rjAudioCacheDelayMs,
    maxAttempts: config.rjAudioCacheMaxAttempts,
  }));

  while (!stopped && config.rjAudioCacheEnabled) {
    let row = null;
    try {
      row = await claimNext(archiveDb);
      if (!row) {
        await sleep(30_000);
        continue;
      }

      const result = await processRow(archiveDb, row);
      processedThisProcess += 1;
      if (result.ok) {
        cachedThisProcess += 1;
        lastCachedAt = new Date().toISOString();
        lastError = null;
        console.log('[rj audio cache] cached', JSON.stringify({
          artist: row.artist,
          title: row.title,
          quality: result.candidate.quality,
          host: result.candidate.host,
          duration: result.duration,
        }));
      } else {
        failedThisProcess += 1;
        lastError = result.errors?.[result.errors.length - 1] || 'direct URL failure';
        console.warn('[rj audio cache] miss', JSON.stringify({
          artist: row.artist,
          title: row.title,
          attempts: row.attempts,
          error: lastError,
        }));
      }

      if (processedThisProcess % 100 === 0) await progress(archiveDb);
    } catch (err) {
      lastError = String(err?.message || err);
      console.error('[rj audio cache]', lastError);
      if (row) {
        try { await markFailure(archiveDb, row, [lastError]); } catch (markErr) {
          console.error('[rj audio cache mark failure]', markErr?.message || markErr);
        }
      }
    }

    await sleep(config.rjAudioCacheDelayMs);
  }

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
    lastCachedAt,
    lastError,
  };
}

export async function getRjAudioCacheSummary() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) return { enabled: false, reason: 'archive_db_missing' };
  await ensureSchema(archiveDb);
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
