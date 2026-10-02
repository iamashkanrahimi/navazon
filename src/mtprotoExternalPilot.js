import { config } from './config.js';
import { bot, bridge, tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { getState, setState } from './state.js';
import {
  sendExternalMediaToOurBot,
  sendExternalMediaBatchToOurBot,
} from './mtproto.js';
import {
  artistCreditCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const PILOT_KEY = 'mtproto_external_media_pilot_v1';
const TOTAL = 20;
const SINGLE_COUNT = 5;
const BATCH_SIZE = 5;

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

async function cleanup(mediaItems = []) {
  for (const media of mediaItems) {
    if (!media?.messageId) continue;
    try {
      await bot.deleteMessage(config.proxyUserId, media.messageId);
    } catch (err) {
      console.warn('[mtproto external pilot cleanup]', err.message);
    }
  }
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

export async function runMtprotoExternalMediaPilot() {
  if (!config.rjMtprotoPilotEnabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const previous = await getState(PILOT_KEY, null);
  if (previous?.status === 'success' && Number(previous?.total || 0) >= TOTAL) {
    console.log('[mtproto external pilot] skipped; already verified');
    return previous;
  }

  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    return { enabled: false, reason: 'archive_db_missing' };
  }

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
    ORDER BY md5(source_url || ':mtproto-external-pilot-v1')
    LIMIT $1
  `, [TOTAL]);

  if (rows.length < TOTAL) {
    return { enabled: true, status: 'waiting', available: rows.length, needed: TOTAL };
  }

  const startedAt = Date.now();
  const results = [];
  await setState(PILOT_KEY, {
    status: 'running',
    startedAt,
    total: TOTAL,
  });

  try {
    for (const row of rows.slice(0, SINGLE_COUNT)) {
      const wait = bridge.expectMedia(45_000);
      await sendExternalMediaToOurBot(
        tg,
        row.direct_url,
        `navazon-mtproto-pilot:${row.source_id || ''}`
      );
      const media = await wait;
      const checked = evaluate(row, media);
      results.push({
        mode: 'single',
        artist: row.artist,
        title: row.title,
        quality: row.direct_quality,
        host: row.direct_host,
        ...checked,
      });
      await cleanup([media]);
    }

    const batchRows = rows.slice(SINGLE_COUNT);
    for (let offset = 0; offset < batchRows.length; offset += BATCH_SIZE) {
      const group = batchRows.slice(offset, offset + BATCH_SIZE);
      const wait = bridge.expectManyMedia(group.length, 60_000);
      await sendExternalMediaBatchToOurBot(
        tg,
        group.map(row => ({
          url: row.direct_url,
          caption: `navazon-mtproto-pilot:${row.source_id || ''}`,
        }))
      );
      const received = await wait;
      const mediaItems = received?.items || [];
      const { pairs, unmatchedMedia } = matchBatch(group, mediaItems);

      for (const { row, media } of pairs) {
        const checked = evaluate(row, media);
        results.push({
          mode: 'batch',
          artist: row.artist,
          title: row.title,
          quality: row.direct_quality,
          host: row.direct_host,
          batchComplete: Boolean(received?.complete),
          ...checked,
        });
      }

      await cleanup([...mediaItems, ...unmatchedMedia]);
    }

    const ok = results.filter(item => item.ok).length;
    const audio = results.filter(item => item.kind === 'audio').length;
    const sameUnique = results.filter(item => item.sameUniqueId).length;
    const sameFileId = results.filter(item => item.sameFileId).length;
    const batchOk = results.filter(item => item.mode === 'batch' && item.ok).length;
    const singleOk = results.filter(item => item.mode === 'single' && item.ok).length;

    const summary = {
      enabled: true,
      status: ok === TOTAL ? 'success' : 'partial',
      total: TOTAL,
      ok,
      audio,
      sameUnique,
      sameFileId,
      singleOk,
      batchOk,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      results,
    };

    await setState(PILOT_KEY, summary);
    console.log('[mtproto external pilot] result', JSON.stringify({
      status: summary.status,
      total: summary.total,
      ok: summary.ok,
      audio: summary.audio,
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
    console.error('[mtproto external pilot] failed', JSON.stringify({
      completed: summary.completed,
      ok: summary.ok,
      error: summary.error,
      elapsedMs: summary.elapsedMs,
    }));
    return summary;
  }
}
