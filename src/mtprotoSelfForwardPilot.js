import { config } from './config.js';
import { bot, bridge, tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { getState, setState } from './state.js';
import {
  sendExternalMediaToPeer,
  sendExternalMediaBatchToPeer,
  forwardHiddenManyToOurBot,
  deleteMessagesById,
} from './mtproto.js';
import {
  artistCreditCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const PILOT_KEY = 'mtproto_external_self_forward_pilot_v2';
const TOTAL = 20;
const SINGLE_COUNT = 5;
const BATCH_SIZE = 5;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function evaluate(row, media) {
  const expectedDuration = Number(row.actual_duration_seconds || row.expected_duration_seconds || 0) || null;
  const actualDuration = Number(media?.duration || 0) || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const titleOk = media?.title
    ? trackTitleIdentityCompatible(row.title, media.title)
    : null;
  const artistOk = media?.performer
    ? artistCreditCompatible(row.artist, media.performer)
    : null;
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

  const ok = Boolean(
    media?.kind === 'audio'
    && media?.fileId
    && (durationDelta == null || durationDelta <= 12)
    && titleOk !== false
    && artistOk !== false
  );

  return {
    ok,
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
    messageId: media?.messageId || null,
  };
}

async function cleanupBridgeMessages(mediaItems = []) {
  for (const media of mediaItems) {
    if (!media?.messageId) continue;
    try {
      await bot.deleteMessage(config.proxyUserId, media.messageId);
    } catch (err) {
      console.warn('[mtproto self-forward pilot cleanup bot]', err.message);
    }
  }
}

async function waitForNewSavedMessageIds(selfPeer, afterId, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const batch = await tg.getMessages(selfPeer, { limit: Math.max(30, expected + 10) });
    const ids = (batch || [])
      .map(message => Number(message?.id || 0))
      .filter(id => id > Number(afterId || 0))
      .sort((a, b) => a - b);
    if (ids.length >= expected) return ids.slice(-expected);
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${expected} Saved Messages media items`);
}

async function createSavedExternalBatch(selfPeer, rows) {
  const latest = await tg.getMessages(selfPeer, { limit: 1 });
  const afterId = Number(latest?.[0]?.id || 0);

  if (rows.length === 1) {
    const row = rows[0];
    await sendExternalMediaToPeer(
      tg,
      selfPeer,
      row.direct_url,
      `navazon-rj:${row.source_id || ''}`
    );
  } else {
    await sendExternalMediaBatchToPeer(
      tg,
      selfPeer,
      rows.map(row => ({
        url: row.direct_url,
        caption: `navazon-rj:${row.source_id || ''}`,
      }))
    );
  }

  return waitForNewSavedMessageIds(selfPeer, afterId, rows.length);
}

function matchBatch(rows, mediaItems) {
  const unused = [...mediaItems];
  const pairs = [];

  for (const row of rows) {
    let index = unused.findIndex(media =>
      row.telegram_file_unique_id
      && media?.fileUniqueId === row.telegram_file_unique_id
    );

    if (index < 0) {
      index = unused.findIndex(media => {
        if (media?.kind !== 'audio') return false;
        const titleOk = media.title
          ? trackTitleIdentityCompatible(row.title, media.title)
          : true;
        const artistOk = media.performer
          ? artistCreditCompatible(row.artist, media.performer)
          : true;
        const expected = Number(row.actual_duration_seconds || row.expected_duration_seconds || 0) || null;
        const actual = Number(media.duration || 0) || null;
        const durationOk = !expected || !actual || Math.abs(expected - actual) <= 12;
        return titleOk && artistOk && durationOk;
      });
    }

    const media = index >= 0 ? unused.splice(index, 1)[0] : null;
    pairs.push({ row, media });
  }

  return { pairs, unmatchedMedia: unused };
}

async function runGroup(selfPeer, rows, mode) {
  const savedIds = await createSavedExternalBatch(selfPeer, rows);
  const wait = bridge.expectManyMedia(rows.length, 60_000);
  await forwardHiddenManyToOurBot(tg, selfPeer, savedIds);
  const received = await wait;
  const mediaItems = received?.items || [];
  const { pairs, unmatchedMedia } = matchBatch(rows, mediaItems);

  const results = pairs.map(({ row, media }) => ({
    mode,
    artist: row.artist,
    title: row.title,
    quality: row.direct_quality,
    host: row.direct_host,
    batchComplete: Boolean(received?.complete),
    ...evaluate(row, media),
  }));

  await cleanupBridgeMessages([...mediaItems, ...unmatchedMedia]);
  try {
    await deleteMessagesById(tg, savedIds);
  } catch (err) {
    console.warn('[mtproto self-forward pilot cleanup saved]', err.message);
  }

  return results;
}

export async function runMtprotoSelfForwardPilot() {
  if (!config.rjMtprotoPilotEnabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const previous = await getState(PILOT_KEY, null);
  if (previous?.status === 'success' && Number(previous?.total || 0) >= TOTAL) {
    console.log('[mtproto self-forward pilot] skipped; already verified');
    return previous;
  }

  const archiveDb = getArchiveDb();
  if (!archiveDb) return { enabled: false, reason: 'archive_db_missing' };

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
    ORDER BY md5(source_url || ':mtproto-self-forward-pilot-v2')
    LIMIT $1
  `, [TOTAL]);

  if (rows.length < TOTAL) {
    return { enabled: true, status: 'waiting', available: rows.length, needed: TOTAL };
  }

  const startedAt = Date.now();
  const results = [];
  await setState(PILOT_KEY, { status: 'running', startedAt, total: TOTAL });

  try {
    const selfPeer = await tg.getMe();

    for (const row of rows.slice(0, SINGLE_COUNT)) {
      results.push(...await runGroup(selfPeer, [row], 'single'));
    }

    const batchRows = rows.slice(SINGLE_COUNT);
    for (let offset = 0; offset < batchRows.length; offset += BATCH_SIZE) {
      results.push(...await runGroup(
        selfPeer,
        batchRows.slice(offset, offset + BATCH_SIZE),
        'batch'
      ));
    }

    const ok = results.filter(item => item.ok).length;
    const sameUnique = results.filter(item => item.sameUniqueId).length;
    const sameFileId = results.filter(item => item.sameFileId).length;
    const singleOk = results.filter(item => item.mode === 'single' && item.ok).length;
    const batchOk = results.filter(item => item.mode === 'batch' && item.ok).length;

    const summary = {
      enabled: true,
      status: ok === TOTAL ? 'success' : 'partial',
      total: TOTAL,
      ok,
      sameUnique,
      sameFileId,
      singleOk,
      batchOk,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      results,
    };
    await setState(PILOT_KEY, summary);
    console.log('[mtproto self-forward pilot] result', JSON.stringify({
      status: summary.status,
      total: summary.total,
      ok: summary.ok,
      sameUnique: summary.sameUnique,
      sameFileId: summary.sameFileId,
      singleOk: summary.singleOk,
      batchOk: summary.batchOk,
      elapsedMs: summary.elapsedMs,
    }));
    return summary;
  } catch (err) {
    const summary = {
      enabled: true,
      status: 'failed',
      total: TOTAL,
      completed: results.length,
      ok: results.filter(item => item.ok).length,
      error: clean(err?.message || err).slice(0, 1200),
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      results,
    };
    await setState(PILOT_KEY, summary);
    console.error('[mtproto self-forward pilot] failed', JSON.stringify({
      completed: summary.completed,
      ok: summary.ok,
      error: summary.error,
      elapsedMs: summary.elapsedMs,
    }));
    return summary;
  }
}
