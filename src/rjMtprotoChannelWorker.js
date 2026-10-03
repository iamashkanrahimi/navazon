import { config } from './config.js';
import { tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { sendExternalMediaToPeer } from './mtproto.js';
import { ensureRjMtprotoArchiveChannel } from './rjMtprotoChannelPilot.js';
import {
  directCandidates,
  verifyTelegramAudio,
  ensureRjAudioCacheSchema,
  markRjAudioCached,
  markRjAudioFailure,
} from './rjAudioCache.js';

const POST_PREFIX = 'navazon-rj-worker:';
const POST_TIMEOUT_MS = 30_000;
const STARTUP_SETTLE_MS = 15_000;
const SUCCESS_WINDOW_FOR_SPEEDUP = 500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let stopped = false;
let workerPromise = null;
let activeTransfer = null;
let channelState = null;
let processedThisProcess = 0;
let cachedThisProcess = 0;
let failedThisProcess = 0;
let rateLimitedThisProcess = 0;
let timedOutThisProcess = 0;
let lateRecoveredThisProcess = 0;
let consecutiveSuccesses = 0;
let currentGapMs = config.rjMtprotoChannelStartGapMs;
let nextSendAt = 0;
let backoffUntil = null;
let lastCachedAt = null;
let lastError = null;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function captionFor(row, candidate) {
  return [
    POST_PREFIX,
    String(row.source_id || ''),
    ':',
    String(candidate.quality || ''),
    ':',
    String(candidate.host || ''),
  ].join('');
}

function parseCaption(post) {
  const caption = clean(post?.caption || '');
  if (!caption.startsWith(POST_PREFIX)) return null;
  const raw = caption.slice(POST_PREFIX.length);
  const [sourceId, qualityRaw, host] = raw.split(':');
  const quality = Number(qualityRaw || 0) || null;
  if (!sourceId) return null;
  return {
    sourceId: String(sourceId),
    quality,
    host: clean(host),
  };
}

function floodWaitSeconds(err) {
  const direct = Number(err?.seconds || err?.value || 0);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);

  const message = String(err?.message || err || '');
  const match = message.match(/FLOOD(?:_PREMIUM)?_WAIT_?(\d+)/i)
    || message.match(/wait of\s+(\d+)\s+seconds/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

function messageFromPost(post) {
  if (!post?.audio?.file_id) return post;
  return {
    ...post,
    audio: {
      ...post.audio,
      file_id: post.audio.file_id,
      file_unique_id: post.audio.file_unique_id || null,
      file_size: post.audio.file_size || null,
      duration: post.audio.duration || null,
      title: post.audio.title || null,
      performer: post.audio.performer || null,
    },
  };
}

function expectChannelPost(sourceId, timeoutMs = POST_TIMEOUT_MS) {
  if (activeTransfer) {
    throw new Error('RJ MTProto channel worker already has an active transfer');
  }

  let settled = false;
  let timer = null;
  let resolvePromise = null;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (activeTransfer?.sourceId === String(sourceId)) activeTransfer = null;
      resolve(null);
    }, timeoutMs);
  });

  activeTransfer = {
    sourceId: String(sourceId),
    resolve(post) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeTransfer = null;
      resolvePromise(post);
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeTransfer = null;
      resolvePromise(null);
    },
  };

  return {
    promise,
    cancel: () => activeTransfer?.sourceId === String(sourceId)
      ? activeTransfer.cancel()
      : null,
  };
}

function candidateFromParsed(row, parsed) {
  return directCandidates(row.source_slug, row.source_id)
    .find(candidate =>
      Number(candidate.quality) === Number(parsed.quality)
      && String(candidate.host) === String(parsed.host)
    ) || null;
}

async function salvageLatePost(parsed, post) {
  const archiveDb = getArchiveDb();
  if (!archiveDb) return;

  try {
    const { rows } = await archiveDb.query(`
      SELECT *
      FROM rj_audio_cache
      WHERE source_id=$1
      ORDER BY updated_at DESC
      LIMIT 2
    `, [parsed.sourceId]);
    if (rows.length !== 1) return;

    const row = rows[0];
    if (row.status === 'cached') return;

    const candidate = candidateFromParsed(row, parsed);
    if (!candidate) return;

    const message = messageFromPost(post);
    const verification = verifyTelegramAudio(row, message);
    if (!verification.ok) {
      console.warn('[rj mtproto worker] late post rejected', JSON.stringify({
        sourceId: parsed.sourceId,
        artist: row.artist,
        title: row.title,
        reason: verification.reason,
      }));
      return;
    }

    await markRjAudioCached(
      archiveDb,
      row,
      candidate,
      message,
      verification,
      {
        retainMessage: true,
        chatId: post?.chat?.id || channelState?.peerId || null,
        acquisition: 'radiojavan_mtproto_channel',
      }
    );
    lateRecoveredThisProcess += 1;
    cachedThisProcess += 1;
    lastCachedAt = new Date().toISOString();
    lastError = null;

    console.log('[rj mtproto worker] late post recovered', JSON.stringify({
      sourceId: parsed.sourceId,
      artist: row.artist,
      title: row.title,
      quality: candidate.quality,
      host: candidate.host,
    }));
  } catch (err) {
    console.warn('[rj mtproto worker] late recovery error', err?.message || err);
  }
}

export function consumeRjMtprotoChannelWorkerPost(post) {
  const parsed = parseCaption(post);
  if (!parsed) return false;

  if (activeTransfer && activeTransfer.sourceId === parsed.sourceId) {
    activeTransfer.resolve(post);
    return true;
  }

  void salvageLatePost(parsed, post);
  return true;
}

async function resetLegacyBotApiClaims(db) {
  const processing = await db.query(`
    UPDATE rj_audio_cache
       SET status='pending',
           attempts=GREATEST(attempts-1, 0),
           started_at=NULL,
           next_attempt_at=NULL,
           updated_at=NOW()
     WHERE status='processing'
       AND updated_at < NOW() - INTERVAL '2 minutes'
    RETURNING source_url
  `);

  const rateLimited = await db.query(`
    UPDATE rj_audio_cache
       SET status='pending',
           attempts=0,
           next_attempt_at=NULL,
           updated_at=NOW()
     WHERE status='retry'
       AND last_error ILIKE '%Too Many Requests%'
    RETURNING source_url
  `);

  console.log('[rj mtproto worker] legacy claims released', JSON.stringify({
    processing: processing.rowCount,
    botApi429: rateLimited.rowCount,
  }));
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
          OR (status='processing' AND updated_at < NOW() - INTERVAL '10 minutes')
        )
      ORDER BY
        CASE
          WHEN status='pending' THEN 0
          WHEN status='retry' THEN 1
          ELSE 2
        END,
        md5(source_url || ':rj-mtproto-channel-v1')
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

async function markTransportRetry(db, row, message, delaySeconds = 120) {
  await db.query(`
    UPDATE rj_audio_cache
       SET status='retry',
           attempts=GREATEST(attempts-1, 0),
           last_error=$2,
           next_attempt_at=NOW() + ($3::int * INTERVAL '1 second'),
           updated_at=NOW()
     WHERE source_url=$1
  `, [
    row.source_url,
    clean(message).slice(0, 1800),
    Math.max(10, Math.ceil(Number(delaySeconds) || 120)),
  ]);
}

async function waitForRateGate() {
  while (!stopped && config.rjMtprotoChannelWorkerEnabled) {
    const backoffMs = backoffUntil
      ? Math.max(0, Date.parse(backoffUntil) - Date.now())
      : 0;
    const sendGapMs = Math.max(0, nextSendAt - Date.now());
    const waitMs = Math.max(backoffMs, sendGapMs);
    if (waitMs <= 0) return;
    await sleep(Math.min(waitMs, 30_000));
  }
}

function noteSuccess() {
  consecutiveSuccesses += 1;
  if (consecutiveSuccesses >= SUCCESS_WINDOW_FOR_SPEEDUP) {
    const next = Math.max(
      config.rjMtprotoChannelMinGapMs,
      currentGapMs - 50
    );
    if (next < currentGapMs) {
      currentGapMs = next;
      console.log('[rj mtproto worker] adaptive speedup', JSON.stringify({
        gapMs: currentGapMs,
      }));
    }
    consecutiveSuccesses = 0;
  }
}

function noteFloodWait(seconds) {
  consecutiveSuccesses = 0;
  currentGapMs = Math.min(
    config.rjMtprotoChannelMaxGapMs,
    Math.max(1500, Math.ceil(currentGapMs * 1.75))
  );
  const until = Date.now() + (Math.max(1, seconds) + 5) * 1000;
  backoffUntil = new Date(until).toISOString();
  console.warn('[rj mtproto worker] flood wait', JSON.stringify({
    seconds,
    backoffUntil,
    gapMs: currentGapMs,
  }));
}

async function processRow(db, row) {
  const errors = [];

  for (const candidate of directCandidates(row.source_slug, row.source_id)) {
    await waitForRateGate();
    if (stopped || !config.rjMtprotoChannelWorkerEnabled) {
      await markTransportRetry(db, row, 'worker stopped during transfer', 30);
      return { ok: false, stopped: true, errors };
    }

    const expected = expectChannelPost(String(row.source_id), POST_TIMEOUT_MS);
    let sent = false;
    try {
      nextSendAt = Date.now() + currentGapMs;
      await sendExternalMediaToPeer(
        tg,
        channelState.peerId,
        candidate.url,
        captionFor(row, candidate)
      );
      sent = true;

      const post = await expected.promise;
      if (!post) {
        timedOutThisProcess += 1;
        const message = `${candidate.host}/${candidate.quality}: channel_post timeout after accepted MTProto send`;
        errors.push(message);
        await markTransportRetry(db, row, message, 120);
        return { ok: false, transportRetry: true, errors };
      }

      const message = messageFromPost(post);
      const verification = verifyTelegramAudio(row, message);
      if (!verification.ok) {
        errors.push(
          `${candidate.host}/${candidate.quality}: ${verification.reason}`
        );
        continue;
      }

      await markRjAudioCached(
        db,
        row,
        candidate,
        message,
        verification,
        {
          retainMessage: true,
          chatId: post?.chat?.id || channelState.peerId,
          acquisition: 'radiojavan_mtproto_channel',
        }
      );

      noteSuccess();
      return {
        ok: true,
        candidate,
        duration: verification.actualDuration,
        fileId: verification.audio.file_id,
        fileUniqueId: verification.audio.file_unique_id || null,
      };
    } catch (err) {
      expected.cancel();
      const floodSeconds = floodWaitSeconds(err);
      const detail = clean(err?.message || err).slice(0, 500);
      errors.push(`${candidate.host}/${candidate.quality}: ${detail}`);

      if (floodSeconds != null) {
        rateLimitedThisProcess += 1;
        noteFloodWait(floodSeconds);
        await markRjAudioFailure(db, row, errors, {
          rateLimited: true,
          retryAfter: floodSeconds + 5,
        });
        return {
          ok: false,
          rateLimited: true,
          retryAfter: floodSeconds,
          errors,
        };
      }

      // If Telegram accepted the external send but something failed afterward,
      // do not immediately spray alternate URLs. A late channel_post can still
      // be salvaged safely by the webhook consumer.
      if (sent) {
        await markTransportRetry(db, row, errors[errors.length - 1], 120);
        return { ok: false, transportRetry: true, errors };
      }
    }
  }

  await markRjAudioFailure(db, row, errors);
  return { ok: false, errors };
}

async function progress(db) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='cached')::int AS cached,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='processing')::int AS processing,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='cached' AND direct_quality=320)::int AS q320,
      COUNT(*) FILTER (WHERE status='cached' AND direct_quality=256)::int AS q256,
      COUNT(*) FILTER (WHERE status='cached' AND canonicalized_at IS NOT NULL)::int AS canonicalized,
      COUNT(*) FILTER (WHERE cached_at >= NOW() - INTERVAL '5 minutes')::int AS c5,
      COUNT(*) FILTER (WHERE cached_at >= NOW() - INTERVAL '15 minutes')::int AS c15,
      MAX(cached_at) AS latest
    FROM rj_audio_cache
  `);
  const summary = rows[0] || {};
  console.log('[rj mtproto worker] progress', JSON.stringify(summary));
  return summary;
}

async function loop() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    console.warn('[rj mtproto worker] ARCHIVE_DATABASE_URL missing; worker disabled');
    return;
  }

  await ensureRjAudioCacheSchema(archiveDb);
  channelState = await ensureRjMtprotoArchiveChannel();

  // Avoid zero-downtime overlap and make sure the current webhook instance is
  // the one receiving channel_post updates before the long run begins.
  await sleep(STARTUP_SETTLE_MS);
  await resetLegacyBotApiClaims(archiveDb);

  const initial = await progress(archiveDb);
  console.log('[rj mtproto worker] started', JSON.stringify({
    channelId: channelState.peerId,
    startGapMs: currentGapMs,
    minGapMs: config.rjMtprotoChannelMinGapMs,
    maxGapMs: config.rjMtprotoChannelMaxGapMs,
    cached: initial.cached,
    remaining: Number(initial.total || 0) - Number(initial.cached || 0),
  }));

  while (!stopped && config.rjMtprotoChannelWorkerEnabled) {
    let row = null;
    try {
      row = await claimNext(archiveDb);
      if (!row) {
        const state = await progress(archiveDb);
        const remaining = Number(state.pending || 0)
          + Number(state.processing || 0)
          + Number(state.retry || 0);
        if (remaining === 0) {
          console.log('[rj mtproto worker] archive complete');
          break;
        }
        await sleep(10_000);
        continue;
      }

      const result = await processRow(archiveDb, row);
      processedThisProcess += 1;

      if (result.ok) {
        cachedThisProcess += 1;
        lastCachedAt = new Date().toISOString();
        lastError = null;

        if (
          cachedThisProcess <= 10
          || cachedThisProcess % 100 === 0
        ) {
          console.log('[rj mtproto worker] cached', JSON.stringify({
            count: cachedThisProcess,
            artist: row.artist,
            title: row.title,
            quality: result.candidate.quality,
            host: result.candidate.host,
            duration: result.duration,
            gapMs: currentGapMs,
          }));
        }
      } else if (result.rateLimited) {
        lastError = result.errors?.[result.errors.length - 1] || 'MTProto flood wait';
      } else if (result.transportRetry) {
        lastError = result.errors?.[result.errors.length - 1] || 'channel transport retry';
      } else if (!result.stopped) {
        failedThisProcess += 1;
        lastError = result.errors?.[result.errors.length - 1] || 'all direct candidates failed';
        console.warn('[rj mtproto worker] miss', JSON.stringify({
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
      lastError = clean(err?.message || err);
      console.error('[rj mtproto worker]', lastError);
      if (row) {
        try {
          const floodSeconds = floodWaitSeconds(err);
          if (floodSeconds != null) {
            noteFloodWait(floodSeconds);
            await markRjAudioFailure(archiveDb, row, [lastError], {
              rateLimited: true,
              retryAfter: floodSeconds + 5,
            });
          } else {
            await markTransportRetry(archiveDb, row, lastError, 120);
          }
        } catch (markErr) {
          console.error('[rj mtproto worker mark retry]', markErr?.message || markErr);
        }
      }
      await sleep(1500);
    }
  }

  console.log('[rj mtproto worker] stopped');
}

export function startRjMtprotoChannelWorker() {
  if (!config.rjMtprotoChannelWorkerEnabled || workerPromise) return workerPromise;
  stopped = false;
  currentGapMs = config.rjMtprotoChannelStartGapMs;
  workerPromise = loop().finally(() => {
    workerPromise = null;
  });
  return workerPromise;
}

export function stopRjMtprotoChannelWorker() {
  stopped = true;
  if (activeTransfer) activeTransfer.cancel();
}

export function getRjMtprotoChannelWorkerRuntimeStatus() {
  return {
    enabled: config.rjMtprotoChannelWorkerEnabled,
    running: Boolean(workerPromise) && !stopped,
    processedThisProcess,
    cachedThisProcess,
    failedThisProcess,
    rateLimitedThisProcess,
    timedOutThisProcess,
    lateRecoveredThisProcess,
    consecutiveSuccesses,
    currentGapMs,
    startGapMs: config.rjMtprotoChannelStartGapMs,
    minGapMs: config.rjMtprotoChannelMinGapMs,
    maxGapMs: config.rjMtprotoChannelMaxGapMs,
    backoffUntil,
    backoffActive: Boolean(backoffUntil && Date.parse(backoffUntil) > Date.now()),
    channel: channelState,
    lastCachedAt,
    lastError,
  };
}

export async function getRjMtprotoChannelWorkerSummary() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    return {
      runtime: getRjMtprotoChannelWorkerRuntimeStatus(),
      archive: null,
      reason: 'archive_db_missing',
    };
  }

  await ensureRjAudioCacheSchema(archiveDb);
  const archive = await progress(archiveDb);
  return {
    runtime: getRjMtprotoChannelWorkerRuntimeStatus(),
    archive,
  };
}
