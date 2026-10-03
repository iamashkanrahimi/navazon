import { config } from './config.js';
import { bot, tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { getState, setState } from './state.js';
import {
  createPrivateArchiveChannel,
  sendExternalMediaToPeer,
} from './mtproto.js';
import {
  artistCreditCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const CHANNEL_KEY = 'rj_mtproto_archive_channel_v1';
const RESULT_KEY = 'rj_mtproto_channel_pilot_v1';
const TOTAL = 20;
const BENCHMARK_TOTAL = 100;
const STARTUP_SETTLE_MS = 15_000;
const BENCHMARK_GAP_MS = 600;
const POST_PREFIX = 'navazon-rj-channel-pilot:';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let activeBatch = null;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sourceIdFromPost(post) {
  const caption = clean(post?.caption || '');
  if (!caption.startsWith(POST_PREFIX)) return null;
  const value = caption.slice(POST_PREFIX.length).trim();
  return value || null;
}

function mediaFromChannelPost(post) {
  if (post?.audio?.file_id) {
    return {
      kind: 'audio',
      fileId: post.audio.file_id,
      fileUniqueId: post.audio.file_unique_id || null,
      duration: Number(post.audio.duration || 0) || null,
      title: clean(post.audio.title) || null,
      performer: clean(post.audio.performer) || null,
      fileSize: Number(post.audio.file_size || 0) || null,
      messageId: post.message_id || null,
      chatId: post.chat?.id || null,
    };
  }

  if (post?.document?.file_id) {
    return {
      kind: 'document',
      fileId: post.document.file_id,
      fileUniqueId: post.document.file_unique_id || null,
      duration: null,
      title: null,
      performer: null,
      fileSize: Number(post.document.file_size || 0) || null,
      messageId: post.message_id || null,
      chatId: post.chat?.id || null,
      mimeType: post.document.mime_type || null,
      fileName: post.document.file_name || null,
    };
  }

  return null;
}

export function consumeRjChannelPilotPost(post) {
  const sourceId = sourceIdFromPost(post);
  if (!sourceId) return false;

  const media = mediaFromChannelPost(post);
  if (!activeBatch || !activeBatch.expected.has(sourceId)) {
    console.log('[rj channel pilot] late/unexpected post', JSON.stringify({
      sourceId,
      kind: media?.kind || null,
      chatId: post?.chat?.id || null,
    }));
    return true;
  }

  if (!activeBatch.items.has(sourceId)) {
    activeBatch.items.set(sourceId, media);
  }

  if (activeBatch.items.size >= activeBatch.expected.size) {
    const batch = activeBatch;
    activeBatch = null;
    clearTimeout(batch.timer);
    batch.resolve(new Map(batch.items));
  }
  return true;
}

function expectBatch(sourceIds, timeoutMs = 60_000) {
  if (activeBatch) throw new Error('RJ MTProto channel pilot already has an active batch');

  const expected = new Set(sourceIds.map(value => String(value)));
  return new Promise(resolve => {
    const batch = {
      expected,
      items: new Map(),
      resolve,
      timer: null,
    };
    batch.timer = setTimeout(() => {
      if (activeBatch === batch) activeBatch = null;
      resolve(new Map(batch.items));
    }, timeoutMs);
    activeBatch = batch;
  });
}

function evaluate(row, media) {
  const expectedDuration = Number(
    row.actual_duration_seconds || row.expected_duration_seconds || 0
  ) || null;
  const actualDuration = Number(media?.duration || 0) || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;

  const titleOk = media?.title
    ? trackTitleIdentityCompatible(row.title, media.title)
    : null;
  const artistOk = media?.performer
    ? artistCreditCompatible(row.artist, media.performer)
    : null;
  const textContradictions = [titleOk, artistOk].filter(value => value === false).length;
  const sameUniqueId = Boolean(
    row.telegram_file_unique_id
    && media?.fileUniqueId
    && row.telegram_file_unique_id === media.fileUniqueId
  );
  const sameFileId = Boolean(
    row.telegram_file_id
    && media?.fileId
    && row.telegram_file_id === media.fileId
  );

  const verified = Boolean(
    media?.kind === 'audio'
    && media?.fileId
    && durationOk
    && textContradictions < 2
  );

  return {
    ok: verified,
    kind: media?.kind || null,
    fileId: media?.fileId || null,
    fileUniqueId: media?.fileUniqueId || null,
    sameUniqueId,
    sameFileId,
    expectedDuration,
    actualDuration,
    durationDelta,
    title: media?.title || null,
    performer: media?.performer || null,
    titleOk,
    artistOk,
    fileSize: media?.fileSize || null,
    messageId: media?.messageId || null,
    chatId: media?.chatId || null,
  };
}

async function ensureArchiveChannel() {
  const current = await getState(CHANNEL_KEY, null);
  if (current?.peerId) {
    try {
      const chat = await bot.getChat(current.peerId);
      if (chat?.id) {
        return {
          ...current,
          botChatType: chat.type || null,
          reused: true,
        };
      }
    } catch (err) {
      console.warn('[rj channel pilot] saved channel unavailable', err.message);
    }
  }

  const created = await createPrivateArchiveChannel(
    tg,
    'Navazon RJ Archive',
    'Private Radio Javan ingestion channel for Navazon'
  );

  let chat = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      chat = await bot.getChat(created.peerId);
      if (chat?.id) break;
    } catch {}
    await sleep(750);
  }

  if (!chat?.id) {
    throw new Error(
      `Navazonbot cannot access the new archive channel ${created.peerId}`
    );
  }

  const saved = {
    ...created,
    botChatType: chat.type || null,
    createdAt: Date.now(),
  };
  await setState(CHANNEL_KEY, saved);
  console.log('[rj channel pilot] archive channel ready', JSON.stringify(saved));
  return saved;
}

async function runBenchmark(archiveDb, channel) {
  const { rows } = await archiveDb.query(`
    SELECT
      source_url, source_id, artist, title,
      direct_url, direct_quality, direct_host,
      telegram_file_id, telegram_file_unique_id,
      expected_duration_seconds, actual_duration_seconds
    FROM rj_audio_cache
    WHERE status='cached'
      AND direct_url IS NOT NULL
      AND telegram_file_id IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(source_id,'')), '') IS NOT NULL
    ORDER BY md5(source_url || ':mtproto-channel-benchmark-v1')
    LIMIT $1
  `, [BENCHMARK_TOTAL]);

  const startedAt = Date.now();
  let received = 0;
  let verified = 0;
  let sameUnique = 0;
  let audio = 0;
  let floodWaitSeconds = null;
  const failures = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceId = String(row.source_id);
    try {
      const receivedPromise = expectBatch([sourceId], 20_000);
      await sendExternalMediaToPeer(
        tg,
        channel.peerId,
        row.direct_url,
        `${POST_PREFIX}${row.source_id}`
      );
      const incoming = await receivedPromise;
      const media = incoming.get(sourceId) || null;
      const checked = evaluate(row, media);
      if (media) received += 1;
      if (checked.kind === 'audio') audio += 1;
      if (checked.ok) verified += 1;
      if (checked.sameUniqueId) sameUnique += 1;

      if (!checked.ok) {
        failures.push({
          index,
          sourceId,
          artist: row.artist,
          title: row.title,
          kind: checked.kind,
          received: Boolean(media),
          sameUniqueId: checked.sameUniqueId,
          durationDelta: checked.durationDelta,
        });
      }
    } catch (err) {
      if (activeBatch) {
        clearTimeout(activeBatch.timer);
        activeBatch = null;
      }
      const message = clean(err?.message || err);
      const seconds = Number(err?.seconds || err?.value || 0) || null;
      failures.push({
        index,
        sourceId,
        artist: row.artist,
        title: row.title,
        error: message.slice(0, 500),
        seconds,
      });
      if (/FLOOD_WAIT/i.test(message) || seconds) {
        floodWaitSeconds = seconds;
        break;
      }
    }

    if ((index + 1) % 20 === 0) {
      console.log('[rj channel benchmark] progress', JSON.stringify({
        completed: index + 1,
        received,
        verified,
        sameUnique,
        elapsedMs: Date.now() - startedAt,
      }));
    }
    if (index + 1 < rows.length) await sleep(BENCHMARK_GAP_MS);
  }

  const completed = received + failures.filter(item => item.error).length;
  const elapsedMs = Date.now() - startedAt;
  const summary = {
    requested: rows.length,
    completed,
    received,
    audio,
    verified,
    sameUnique,
    failures: failures.slice(0, 20),
    floodWaitSeconds,
    elapsedMs,
    verifiedPerMinute: elapsedMs > 0
      ? Number((verified * 60_000 / elapsedMs).toFixed(1))
      : null,
  };
  console.log('[rj channel benchmark] result', JSON.stringify({
    requested: summary.requested,
    completed: summary.completed,
    received: summary.received,
    audio: summary.audio,
    verified: summary.verified,
    sameUnique: summary.sameUnique,
    failureCount: failures.length,
    floodWaitSeconds: summary.floodWaitSeconds,
    elapsedMs: summary.elapsedMs,
    verifiedPerMinute: summary.verifiedPerMinute,
  }));
  return summary;
}

export async function runRjMtprotoChannelPilot() {
  if (!config.rjMtprotoChannelPilotEnabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const previous = await getState(RESULT_KEY, null);
  if (previous?.status === 'success' && Number(previous?.ok || 0) >= TOTAL) {
    console.log('[rj channel pilot] skipped; already verified');
    return previous;
  }

  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    return { enabled: false, reason: 'archive_db_missing' };
  }

  const channel = await ensureArchiveChannel();

  // Zero-downtime deploys briefly keep the previous instance alive. Waiting
  // here makes sure channel_post updates land on the same process that owns
  // this pilot's waiter.
  await sleep(STARTUP_SETTLE_MS);

  const { rows } = await archiveDb.query(`
    SELECT
      source_url, source_id, source_slug, artist, title,
      direct_url, direct_quality, direct_host,
      telegram_file_id, telegram_file_unique_id,
      expected_duration_seconds, actual_duration_seconds
    FROM rj_audio_cache
    WHERE status='cached'
      AND direct_url IS NOT NULL
      AND telegram_file_id IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(source_id,'')), '') IS NOT NULL
    ORDER BY md5(source_url || ':mtproto-channel-pilot-v1')
    LIMIT $1
  `, [TOTAL]);

  if (rows.length < TOTAL) {
    return {
      enabled: true,
      status: 'waiting',
      available: rows.length,
      needed: TOTAL,
      channel,
    };
  }

  const startedAt = Date.now();
  const results = [];
  await setState(RESULT_KEY, {
    enabled: true,
    status: 'running',
    total: TOTAL,
    startedAt,
    channel,
  });

  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sourceId = String(row.source_id);
      const receivedPromise = expectBatch([sourceId], 60_000);

      // Telegram rejects InputMediaDocumentExternal inside SendMultiMedia for
      // this private broadcast channel (MEDIA_INVALID). Use the simpler
      // SendMedia path one item at a time for the pilot.
      await sendExternalMediaToPeer(
        tg,
        channel.peerId,
        row.direct_url,
        `${POST_PREFIX}${row.source_id}`
      );

      const received = await receivedPromise;
      const media = received.get(sourceId) || null;
      const checked = {
        sourceId,
        artist: row.artist,
        title: row.title,
        quality: row.direct_quality,
        host: row.direct_host,
        received: Boolean(media),
        ...evaluate(row, media),
      };
      results.push(checked);

      console.log('[rj channel pilot] item', JSON.stringify({
        index,
        sourceId,
        received: checked.received,
        kind: checked.kind,
        verified: checked.ok,
        sameUniqueId: checked.sameUniqueId,
      }));

      if (index + 1 < rows.length) await sleep(900);
    }

    const ok = results.filter(item => item.ok).length;
    const received = results.filter(item => item.received).length;
    const audio = results.filter(item => item.kind === 'audio').length;
    const sameUnique = results.filter(item => item.sameUniqueId).length;
    const sameFileId = results.filter(item => item.sameFileId).length;

    const benchmark = ok >= TOTAL - 1
      ? await runBenchmark(archiveDb, channel)
      : null;

    const summary = {
      enabled: true,
      status: ok === TOTAL ? 'success' : (received ? 'partial' : 'failed'),
      total: TOTAL,
      received,
      audio,
      ok,
      sameUnique,
      sameFileId,
      channel,
      benchmark,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      results,
    };
    await setState(RESULT_KEY, summary);
    console.log('[rj channel pilot] result', JSON.stringify({
      status: summary.status,
      total: summary.total,
      received: summary.received,
      audio: summary.audio,
      ok: summary.ok,
      sameUnique: summary.sameUnique,
      sameFileId: summary.sameFileId,
      elapsedMs: summary.elapsedMs,
    }));
    return summary;
  } catch (err) {
    if (activeBatch) {
      clearTimeout(activeBatch.timer);
      activeBatch = null;
    }
    const summary = {
      enabled: true,
      status: 'failed',
      total: TOTAL,
      completed: results.length,
      ok: results.filter(item => item.ok).length,
      channel,
      error: clean(err?.message || err).slice(0, 1200),
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      results,
    };
    await setState(RESULT_KEY, summary);
    console.error('[rj channel pilot] failed', JSON.stringify({
      completed: summary.completed,
      ok: summary.ok,
      error: summary.error,
      elapsedMs: summary.elapsedMs,
    }));
    return summary;
  }
}

export async function getRjMtprotoChannelPilotSummary() {
  const result = await getState(RESULT_KEY, null);
  const channel = await getState(CHANNEL_KEY, null);
  return {
    enabled: config.rjMtprotoChannelPilotEnabled,
    channel,
    result,
  };
}
