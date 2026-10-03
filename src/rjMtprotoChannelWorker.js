import { config } from './config.js';
import { tg, tg2, tg3 } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import {
  sendExternalMediaToPeer,
  sendLocalAudioFileToPeer,
} from './mtproto.js';
import { ensureRjMtprotoArchiveChannelFor } from './rjMtprotoChannelPilot.js';
import { getState, setState } from './state.js';
import {
  directCandidatesForRow,
  verifyTelegramAudio,
  ensureRjAudioCacheSchema,
  markRjAudioCached,
  markRjAudioFailure,
} from './rjAudioCache.js';
import { prepareFailedRjAudioRecovery } from './rjApiRecovery.js';
import {
  selectRjApiUploadCandidate,
  downloadRjAudioToTemp,
  cleanupRjTempFile,
} from './rjLocalUploadRecovery.js';

const POST_PREFIX = 'navazon-rj-worker:';
const POST_TIMEOUT_MS = 30_000;
const STARTUP_SETTLE_MS = 15_000;
const SUCCESS_WINDOW_FOR_SPEEDUP = 500;
const LOCAL_UPLOAD_CONCURRENCY = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let stopped = false;
let workerPromise = null;
const accountStates = new Map();

let processedThisProcess = 0;
let cachedThisProcess = 0;
let failedThisProcess = 0;
let lateRecoveredThisProcess = 0;
let lastCachedAt = null;
let lastError = null;

let localUploadActive = 0;
const localUploadWaiters = [];

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function acquireLocalUploadSlot() {
  if (localUploadActive < LOCAL_UPLOAD_CONCURRENCY) {
    localUploadActive += 1;
    return () => {
      localUploadActive = Math.max(0, localUploadActive - 1);
      const next = localUploadWaiters.shift();
      if (next) next();
    };
  }

  await new Promise(resolve => localUploadWaiters.push(resolve));
  localUploadActive += 1;
  return () => {
    localUploadActive = Math.max(0, localUploadActive - 1);
    const next = localUploadWaiters.shift();
    if (next) next();
  };
}

async function recordLocalUploadEvidence(db, row, patch = {}) {
  await db.query(`
    UPDATE rj_audio_cache
       SET verification = COALESCE(verification,'{}'::jsonb) || $2::jsonb,
           updated_at=NOW()
     WHERE source_url=$1
  `, [
    row.source_url,
    JSON.stringify({
      localUploadRecovery: {
        version: 2,
        attemptedAt: new Date().toISOString(),
        ...patch,
      },
    }),
  ]);
}

function localUploadRetryable(row = {}) {
  const previous = row?.verification?.localUploadRecovery || null;
  if (!previous) return true;
  if (previous.ok == null) return true;
  if (previous.ok === true) return false;
  if (Number(previous.version || 0) >= 2) return false;
  const reason = clean(previous.reason || '');
  return previous.ok === false
    && reason.includes('unexpected content-type text/plain');
}

async function resetFailedApiRowsForLocalUpload(db) {
  const result = await db.query(`
    UPDATE rj_audio_cache
       SET status='pending',
           attempts=0,
           last_error=NULL,
           next_attempt_at=NULL,
           started_at=NULL,
           updated_at=NOW()
     WHERE status IN ('failed','retry')
       AND verification->'apiRecovery'->>'prepared'='true'
       AND (
         NOT (COALESCE(verification,'{}'::jsonb) ? 'localUploadRecovery')
         OR (verification->'localUploadRecovery'->>'ok') IS NULL
         OR (
           COALESCE(verification->'localUploadRecovery'->>'ok','')='false'
           AND COALESCE(verification->'localUploadRecovery'->>'reason','')
             ILIKE '%unexpected content-type text/plain%'
           AND COALESCE((verification->'localUploadRecovery'->>'version')::int,0) < 2
         )
       )
    RETURNING source_url
  `);
  if (result.rowCount) {
    console.log('[rj local upload] released recoverable rows', result.rowCount);
  }
  return result.rowCount;
}

function pacingStateKey(slot) {
  return `rj_mtproto_channel_worker_pacing_v1_slot_${slot}`;
}

function createAccountState(slot, client) {
  return {
    slot,
    client,
    activeTransfers: new Map(),
    startGateChain: Promise.resolve(),
    channelState: null,
    processed: 0,
    cached: 0,
    failed: 0,
    rateLimited: 0,
    timedOut: 0,
    lateRecovered: 0,
    consecutiveSuccesses: 0,
    currentGapMs: config.rjMtprotoChannelStartGapMs,
    nextSendAt: 0,
    backoffUntil: null,
    lastCachedAt: null,
    lastError: null,
  };
}

function configuredAccounts() {
  const items = [createAccountState(1, tg)];
  if (tg2) items.push(createAccountState(2, tg2));
  if (tg3) items.push(createAccountState(3, tg3));
  return items;
}

async function hydratePacing(state) {
  try {
    const saved = await getState(pacingStateKey(state.slot), null);
    const savedGap = Number(saved?.currentGapMs || 0);
    if (Number.isFinite(savedGap) && savedGap > 0) {
      state.currentGapMs = Math.max(
        config.rjMtprotoChannelMinGapMs,
        Math.min(config.rjMtprotoChannelMaxGapMs, savedGap)
      );
    }
    if (
      saved?.backoffUntil
      && Number.isFinite(Date.parse(saved.backoffUntil))
      && Date.parse(saved.backoffUntil) > Date.now()
    ) {
      state.backoffUntil = saved.backoffUntil;
    }
  } catch (err) {
    console.warn('[rj mtproto worker] pacing hydrate', state.slot, err?.message || err);
  }
}

async function persistPacing(state, extra = {}) {
  try {
    await setState(pacingStateKey(state.slot), {
      slot: state.slot,
      currentGapMs: state.currentGapMs,
      backoffUntil: state.backoffUntil,
      updatedAt: Date.now(),
      ...extra,
    });
  } catch (err) {
    console.warn('[rj mtproto worker] pacing persist', state.slot, err?.message || err);
  }
}

function captionFor(state, row, candidate) {
  return [
    POST_PREFIX,
    String(state.slot),
    ':',
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
  const parts = raw.split(':');

  // v2 captions include account slot:
  // navazon-rj-worker:<slot>:<source_id>:<quality>:<host>
  if (parts.length >= 4 && /^\d+$/.test(parts[0] || '')) {
    const [slotRaw, sourceId, qualityRaw, host] = parts;
    const slot = Number(slotRaw);
    const quality = Number(qualityRaw || 0) || null;
    if (!sourceId || !Number.isFinite(slot) || slot < 1) return null;
    return {
      slot,
      sourceId: String(sourceId),
      quality,
      host: clean(host),
    };
  }

  // Backward compatibility for in-flight posts from the original single
  // account worker during a zero-downtime deployment.
  const [sourceId, qualityRaw, host] = parts;
  const quality = Number(qualityRaw || 0) || null;
  if (!sourceId) return null;
  return {
    slot: 1,
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

function expectChannelPost(state, sourceId, timeoutMs = POST_TIMEOUT_MS) {
  const key = String(sourceId);
  if (state.activeTransfers.has(key)) {
    throw new Error(
      `RJ MTProto channel worker slot ${state.slot} already waits for source ${key}`
    );
  }

  let settled = false;
  let timer = null;
  let resolvePromise = null;
  const transfer = {
    sourceId: key,
    resolve(post) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      state.activeTransfers.delete(key);
      resolvePromise(post);
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      state.activeTransfers.delete(key);
      resolvePromise(null);
    },
  };

  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.activeTransfers.delete(key);
      resolve(null);
    }, timeoutMs);
  });

  state.activeTransfers.set(key, transfer);
  return {
    promise,
    cancel: () => state.activeTransfers.get(key)?.cancel(),
  };
}

function candidateFromParsed(row, parsed) {
  return directCandidatesForRow(row)
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
        slot: parsed.slot,
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
        chatId: post?.chat?.id || null,
        acquisition: 'radiojavan_mtproto_channel',
      }
    );

    const state = accountStates.get(parsed.slot);
    if (state) {
      state.lateRecovered += 1;
      state.cached += 1;
      state.lastCachedAt = new Date().toISOString();
      state.lastError = null;
    }
    lateRecoveredThisProcess += 1;
    cachedThisProcess += 1;
    lastCachedAt = new Date().toISOString();
    lastError = null;

    console.log('[rj mtproto worker] late post recovered', JSON.stringify({
      slot: parsed.slot,
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

  const state = accountStates.get(parsed.slot);
  const transfer = state?.activeTransfers?.get(parsed.sourceId);
  if (transfer) {
    transfer.resolve(post);
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

  // These rows were consumed by the retired Bot API URL-fetch path. Give the
  // MTProto path a clean retry budget instead of carrying old transport
  // failures forward.
  const legacyBotApi = await db.query(`
    UPDATE rj_audio_cache
       SET status='pending',
           attempts=0,
           next_attempt_at=NULL,
           updated_at=NOW()
     WHERE status='retry'
       AND (
         last_error ILIKE '%Bot API sendAudio%'
         OR last_error ILIKE '%Too Many Requests%'
         OR last_error='recovered after worker restart'
       )
    RETURNING source_url
  `);

  console.log('[rj mtproto worker] legacy claims released', JSON.stringify({
    processing: processing.rowCount,
    botApiRetry: legacyBotApi.rowCount,
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
        md5(source_url || ':rj-mtproto-channel-v2')
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

async function acquireSendStartSlot(state) {
  const scheduled = state.startGateChain.then(async () => {
    while (!stopped && config.rjMtprotoChannelWorkerEnabled) {
      const backoffMs = state.backoffUntil
        ? Math.max(0, Date.parse(state.backoffUntil) - Date.now())
        : 0;
      const sendGapMs = Math.max(0, state.nextSendAt - Date.now());
      const waitMs = Math.max(backoffMs, sendGapMs);
      if (waitMs <= 0) break;
      await sleep(Math.min(waitMs, 30_000));
    }

    if (stopped || !config.rjMtprotoChannelWorkerEnabled) return false;
    state.nextSendAt = Date.now() + state.currentGapMs;
    return true;
  });

  state.startGateChain = scheduled.catch(() => {});
  return scheduled;
}

async function noteSuccess(state) {
  state.consecutiveSuccesses += 1;
  if (state.consecutiveSuccesses >= SUCCESS_WINDOW_FOR_SPEEDUP) {
    const next = Math.max(
      config.rjMtprotoChannelMinGapMs,
      state.currentGapMs - 50
    );
    if (next < state.currentGapMs) {
      state.currentGapMs = next;
      console.log('[rj mtproto worker] adaptive speedup', JSON.stringify({
        slot: state.slot,
        gapMs: state.currentGapMs,
      }));
      await persistPacing(state, { reason: 'adaptive_speedup' });
    }
    state.consecutiveSuccesses = 0;
  }
}

async function noteFloodWait(state, seconds) {
  state.consecutiveSuccesses = 0;
  state.currentGapMs = Math.min(
    config.rjMtprotoChannelMaxGapMs,
    Math.max(
      config.rjMtprotoChannelStartGapMs,
      Math.ceil(state.currentGapMs * 1.75)
    )
  );
  const until = Date.now() + (Math.max(1, seconds) + 5) * 1000;
  state.backoffUntil = new Date(until).toISOString();
  state.rateLimited += 1;
  await persistPacing(state, {
    reason: 'flood_wait',
    floodWaitSeconds: seconds,
  });
  console.warn('[rj mtproto worker] flood wait', JSON.stringify({
    slot: state.slot,
    seconds,
    backoffUntil: state.backoffUntil,
    gapMs: state.currentGapMs,
  }));
}

async function tryLocalUploadRecovery(db, row, state, errors) {
  if (row?.verification?.apiRecovery?.prepared !== true) return null;
  if (!localUploadRetryable(row)) return null;

  const candidate = selectRjApiUploadCandidate(row);
  if (!candidate) {
    await recordLocalUploadEvidence(db, row, {
      ok: false,
      reason: 'no safe fresh RJ API candidate for local upload',
    });
    errors.push('local-upload: no safe fresh RJ API candidate');
    return { ok:false };
  }

  const release = await acquireLocalUploadSlot();
  let downloaded = null;
  try {
    downloaded = await downloadRjAudioToTemp(candidate, row.source_id);
    await recordLocalUploadEvidence(db, row, {
      ok: null,
      stage: 'downloaded',
      url: candidate.url,
      host: candidate.host,
      quality: candidate.quality,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      contentType: downloaded.contentType,
      identityEvidence: 'fresh_rj_api_source_id_artist_title',
    });

    const allowed = await acquireSendStartSlot(state);
    if (!allowed) {
      throw new Error('worker stopped before local MTProto upload');
    }

    const expected = expectChannelPost(
      state,
      String(row.source_id),
      Math.max(POST_TIMEOUT_MS, 90_000)
    );

    try {
      await sendLocalAudioFileToPeer(
        state.client,
        state.channelState.peerId,
        downloaded.path,
        captionFor(state, row, candidate),
        {
          duration: Number(row.expected_duration_seconds || 0) || 0,
          title: row.title,
          performer: row.artist,
        }
      );

      const post = await expected.promise;
      if (!post) {
        state.timedOut += 1;
        throw new Error('local MTProto upload channel_post timeout');
      }

      const message = messageFromPost(post);
      const verification = verifyTelegramAudio(row, message);
      if (!verification.ok) {
        throw new Error(`local upload verification rejected: ${verification.reason}`);
      }

      await recordLocalUploadEvidence(db, row, {
        ok: true,
        stage: 'verified',
        url: candidate.url,
        host: candidate.host,
        quality: candidate.quality,
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        contentType: downloaded.contentType,
        identityEvidence: 'fresh_rj_api_source_id_artist_title',
      });

      await markRjAudioCached(
        db,
        row,
        candidate,
        message,
        verification,
        {
          retainMessage: true,
          chatId: post?.chat?.id || state.channelState.peerId,
          acquisition: 'radiojavan_api_local_upload',
        }
      );

      await noteSuccess(state);
      console.log('[rj local upload] cached', JSON.stringify({
        slot: state.slot,
        artist: row.artist,
        title: row.title,
        quality: candidate.quality,
        host: candidate.host,
        bytes: downloaded.bytes,
      }));

      return {
        ok: true,
        candidate,
        duration: verification.actualDuration,
        fileId: verification.audio.file_id,
        fileUniqueId: verification.audio.file_unique_id || null,
        localUpload: true,
      };
    } catch (err) {
      expected.cancel();
      throw err;
    }
  } catch (err) {
    const detail = clean(err?.message || err).slice(0, 800);
    errors.push(`local-upload: ${detail}`);
    await recordLocalUploadEvidence(db, row, {
      ok: false,
      stage: downloaded ? 'upload_or_verify' : 'download',
      reason: detail,
      url: candidate.url,
      host: candidate.host,
      quality: candidate.quality,
      bytes: downloaded?.bytes || null,
      sha256: downloaded?.sha256 || null,
      contentType: downloaded?.contentType || null,
      identityEvidence: 'fresh_rj_api_source_id_artist_title',
    });
    return { ok:false };
  } finally {
    await cleanupRjTempFile(downloaded?.path);
    release();
  }
}

async function processRow(db, row, state) {
  const errors = [];
  const allCandidates = directCandidatesForRow(row);
  const candidates = row?.verification?.apiRecovery?.prepared === true
    ? allCandidates
        .filter(candidate => ['rj_api_primary','rj_api_hq'].includes(String(candidate?.source || '')))
        .sort((a, b) => {
          const rank = source => source === 'rj_api_primary' ? 0 : 1;
          return rank(String(a?.source || '')) - rank(String(b?.source || ''));
        })
    : allCandidates;

  for (const candidate of candidates) {
    const allowed = await acquireSendStartSlot(state);
    if (!allowed) {
      await markTransportRetry(db, row, 'worker stopped during transfer', 30);
      return { ok: false, stopped: true, errors };
    }

    const expected = expectChannelPost(
      state,
      String(row.source_id),
      POST_TIMEOUT_MS
    );
    let sent = false;
    try {
      await sendExternalMediaToPeer(
        state.client,
        state.channelState.peerId,
        candidate.url,
        captionFor(state, row, candidate)
      );
      sent = true;

      const post = await expected.promise;
      if (!post) {
        state.timedOut += 1;
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
          chatId: post?.chat?.id || state.channelState.peerId,
          acquisition: 'radiojavan_mtproto_channel',
        }
      );

      await noteSuccess(state);
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
        await noteFloodWait(state, floodSeconds);
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

  const localRecovery = await tryLocalUploadRecovery(db, row, state, errors);
  if (localRecovery?.ok) return localRecovery;

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

async function workerLoop(archiveDb, state, workerId) {
  while (!stopped && config.rjMtprotoChannelWorkerEnabled) {
    let row = null;
    try {
      row = await claimNext(archiveDb);
      if (!row) {
        const status = await progress(archiveDb);
        const remaining = Number(status.pending || 0)
          + Number(status.processing || 0)
          + Number(status.retry || 0);
        if (remaining === 0) return;
        await sleep(5_000);
        continue;
      }

      const result = await processRow(archiveDb, row, state);
      processedThisProcess += 1;
      state.processed += 1;

      if (result.ok) {
        cachedThisProcess += 1;
        state.cached += 1;
        const now = new Date().toISOString();
        lastCachedAt = now;
        state.lastCachedAt = now;
        lastError = null;
        state.lastError = null;

        if (state.cached <= 10 || state.cached % 100 === 0) {
          console.log('[rj mtproto worker] cached', JSON.stringify({
            slot: state.slot,
            workerId,
            count: state.cached,
            artist: row.artist,
            title: row.title,
            quality: result.candidate.quality,
            host: result.candidate.host,
            duration: result.duration,
            gapMs: state.currentGapMs,
          }));
        }
      } else if (result.rateLimited) {
        state.lastError = result.errors?.[result.errors.length - 1] || 'MTProto flood wait';
        lastError = state.lastError;
      } else if (result.transportRetry) {
        state.lastError = result.errors?.[result.errors.length - 1] || 'channel transport retry';
        lastError = state.lastError;
      } else if (!result.stopped) {
        failedThisProcess += 1;
        state.failed += 1;
        state.lastError = result.errors?.[result.errors.length - 1] || 'all direct candidates failed';
        lastError = state.lastError;
        console.warn('[rj mtproto worker] miss', JSON.stringify({
          slot: state.slot,
          workerId,
          artist: row.artist,
          title: row.title,
          attempts: row.attempts,
          error: state.lastError,
        }));
      }

      if (processedThisProcess > 0 && processedThisProcess % 250 === 0) {
        await progress(archiveDb);
      }
    } catch (err) {
      state.lastError = clean(err?.message || err);
      lastError = state.lastError;
      console.error('[rj mtproto worker]', state.slot, workerId, state.lastError);
      if (row) {
        try {
          const floodSeconds = floodWaitSeconds(err);
          if (floodSeconds != null) {
            await noteFloodWait(state, floodSeconds);
            await markRjAudioFailure(archiveDb, row, [state.lastError], {
              rateLimited: true,
              retryAfter: floodSeconds + 5,
            });
          } else {
            await markTransportRetry(archiveDb, row, state.lastError, 120);
          }
        } catch (markErr) {
          console.error(
            '[rj mtproto worker mark retry]',
            state.slot,
            markErr?.message || markErr
          );
        }
      }
      await sleep(1500);
    }
  }
}

async function loop() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    console.warn('[rj mtproto worker] ARCHIVE_DATABASE_URL missing; worker disabled');
    return;
  }

  await ensureRjAudioCacheSchema(archiveDb);

  const accounts = configuredAccounts();
  accountStates.clear();
  for (const state of accounts) {
    accountStates.set(state.slot, state);
    await hydratePacing(state);
    state.channelState = await ensureRjMtprotoArchiveChannelFor(
      state.client,
      { slot: state.slot }
    );
  }

  // Avoid zero-downtime overlap and make sure channel_post updates land on the
  // same process that owns the current waiters before the long run begins.
  await sleep(STARTUP_SETTLE_MS);
  await resetLegacyBotApiClaims(archiveDb);

  const recovery = await prepareFailedRjAudioRecovery(archiveDb);
  if (Number(recovery?.scanned || 0) > 0) {
    console.log('[rj mtproto worker] API recovery', JSON.stringify(recovery));
  }
  await resetFailedApiRowsForLocalUpload(archiveDb);

  const initial = await progress(archiveDb);
  console.log('[rj mtproto worker] started', JSON.stringify({
    accounts: accounts.map(state => ({
      slot: state.slot,
      channelId: state.channelState?.peerId || null,
      startGapMs: state.currentGapMs,
      minGapMs: config.rjMtprotoChannelMinGapMs,
      maxGapMs: config.rjMtprotoChannelMaxGapMs,
      concurrency: config.rjMtprotoChannelConcurrency,
      backoffUntil: state.backoffUntil,
    })),
    cached: initial.cached,
    remaining: Number(initial.total || 0) - Number(initial.cached || 0),
  }));

  await Promise.all(
    accounts.flatMap(state =>
      Array.from(
        { length: config.rjMtprotoChannelConcurrency },
        (_, index) => workerLoop(archiveDb, state, index + 1)
      )
    )
  );

  const finalState = await progress(archiveDb);
  const remaining = Number(finalState.pending || 0)
    + Number(finalState.processing || 0)
    + Number(finalState.retry || 0);
  if (remaining === 0) {
    console.log('[rj mtproto worker] archive complete');
  }
  console.log('[rj mtproto worker] stopped');
}

export function startRjMtprotoChannelWorker() {
  if (!config.rjMtprotoChannelWorkerEnabled || workerPromise) return workerPromise;
  stopped = false;
  workerPromise = loop().finally(() => {
    workerPromise = null;
  });
  return workerPromise;
}

export function stopRjMtprotoChannelWorker() {
  stopped = true;
  for (const state of accountStates.values()) {
    for (const transfer of state.activeTransfers.values()) transfer.cancel();
    state.activeTransfers.clear();
  }
}

function accountRuntimeStatus(state) {
  return {
    slot: state.slot,
    processedThisProcess: state.processed,
    cachedThisProcess: state.cached,
    failedThisProcess: state.failed,
    rateLimitedThisProcess: state.rateLimited,
    timedOutThisProcess: state.timedOut,
    lateRecoveredThisProcess: state.lateRecovered,
    consecutiveSuccesses: state.consecutiveSuccesses,
    currentGapMs: state.currentGapMs,
    startGapMs: config.rjMtprotoChannelStartGapMs,
    minGapMs: config.rjMtprotoChannelMinGapMs,
    maxGapMs: config.rjMtprotoChannelMaxGapMs,
    concurrency: config.rjMtprotoChannelConcurrency,
    inFlight: state.activeTransfers.size,
    backoffUntil: state.backoffUntil,
    backoffActive: Boolean(
      state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()
    ),
    channel: state.channelState,
    lastCachedAt: state.lastCachedAt,
    lastError: state.lastError,
  };
}

export function getRjMtprotoChannelWorkerRuntimeStatus() {
  return {
    enabled: config.rjMtprotoChannelWorkerEnabled,
    running: Boolean(workerPromise) && !stopped,
    configuredAccountCount: tg3 ? 3 : (tg2 ? 2 : 1),
    activeAccountCount: accountStates.size,
    processedThisProcess,
    cachedThisProcess,
    failedThisProcess,
    lateRecoveredThisProcess,
    lastCachedAt,
    lastError,
    accounts: [...accountStates.values()].map(accountRuntimeStatus),
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
