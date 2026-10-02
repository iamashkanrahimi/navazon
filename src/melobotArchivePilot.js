import { config } from './config.js';
import { db, bridge, tg } from './runtime.js';
import { searchMeloBot, resolveMeloBotTrackCandidate, downloadMeloBotTrackQuality } from './sources/melobot.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import { normalizeText, artistCreditCompatible, trackTitleIdentityCompatible } from './text.js';

const PILOT_VERSION = 'melobot-gap-v1-50';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS melobot_archive_pilot (
      source_url TEXT PRIMARY KEY,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      expected_duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      query TEXT NOT NULL,
      candidate JSONB,
      file_id TEXT,
      file_unique_id TEXT,
      media_kind TEXT,
      file_size BIGINT,
      actual_duration_seconds INTEGER,
      audio_title TEXT,
      audio_performer TEXT,
      pilot_version TEXT NOT NULL DEFAULT '${PILOT_VERSION}',
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function candidateMatches(candidate, row) {
  return Boolean(
    candidate?.title
    && candidate?.artist
    && trackTitleIdentityCompatible(row.title, candidate.title)
    && artistCreditCompatible(row.artist, candidate.artist)
  );
}

function forwardedMatches(media, row) {
  const titleOk = media?.title
    ? trackTitleIdentityCompatible(row.title, media.title)
    : null;
  const artistOk = media?.performer
    ? artistCreditCompatible(row.artist, media.performer)
    : null;
  const durationOk = media?.duration && row.expected_duration_seconds
    ? Math.abs(Number(media.duration) - Number(row.expected_duration_seconds)) <= 12
    : null;
  const contradictions = [titleOk, artistOk].filter(v => v === false).length;
  return durationOk !== false && contradictions === 0 && (titleOk === true || artistOk === true);
}

async function capture(audioMessage, row) {
  const wait = bridge.expectMediaMatching(media => forwardedMatches(media, row), 15000);
  await forwardHiddenToOurBot(tg, config.melobotUsername, audioMessage.id);
  return wait;
}

export async function seedMeloBotArchivePilot(sourceQueue) {
  if (!config.melobotArchivePilotEnabled) return { enabled: false, queued: 0 };
  await ensureSchema();
  await db.query(`
    INSERT INTO melobot_archive_pilot (
      source_url, artist, title, expected_duration_seconds, query
    )
    SELECT source_url, artist, title, expected_duration_seconds,
           BTRIM(artist || ' ' || title)
    FROM ahangify_archive_media a
    WHERE a.status IN ('no_confident_match','failed')
      AND a.file_id IS NULL
    ORDER BY
      CASE WHEN a.expected_duration_seconds IS NOT NULL THEN 0 ELSE 1 END,
      a.source_url
    LIMIT $1
    ON CONFLICT (source_url) DO NOTHING
  `, [config.melobotArchivePilotCount]);

  const { rows } = await db.query(`
    SELECT source_url
    FROM melobot_archive_pilot
    WHERE pilot_version=$1 AND status IN ('pending','retry') AND attempts < 2
    ORDER BY attempts, source_url
  `, [PILOT_VERSION]);

  let queued = 0;
  for (const row of rows) {
    if (sourceQueue.push({ type: 'melobot_archive_pilot', sourceUrl: row.source_url })) queued += 1;
  }
  return { enabled: true, version: PILOT_VERSION, queued };
}

export async function runMeloBotArchivePilotJob(job) {
  await ensureSchema();
  const claimed = await db.query(`
    UPDATE melobot_archive_pilot
       SET status='running', attempts=attempts+1, last_error=NULL, updated_at=NOW()
     WHERE source_url=$1 AND status IN ('pending','retry') AND attempts < 2
    RETURNING *
  `, [job.sourceUrl]);
  if (!claimed.rowCount) return { status: 'skipped' };
  const row = claimed.rows[0];

  try {
    const results = await searchMeloBot(tg, row.query, { timeoutMs: 7000, maxRefinements: 3 });
    const matches = results.filter(candidate => candidateMatches(candidate, row));
    if (!matches.length) {
      await db.query(`
        UPDATE melobot_archive_pilot
           SET status='no_confident_match', completed_at=NOW(),
               last_error='No exact MeloBot artist/title candidate', updated_at=NOW()
         WHERE source_url=$1
      `, [row.source_url]);
      return { status: 'no_confident_match', artist: row.artist, title: row.title };
    }

    let lastError = null;
    for (const candidate of matches.slice(0, 3)) {
      try {
        const resolved = await resolveMeloBotTrackCandidate(tg, candidate, {
          timeoutMs: 6500,
          forceIdentity: true,
        });
        if (!candidateMatches(resolved, row)) continue;
        const result = await downloadMeloBotTrackQuality(tg, resolved, 'hq', {
          timeoutMs: 15000,
          menuTimeoutMs: 5000,
          deliveryTimeoutMs: 8000,
        });
        const media = await capture(result.audioMessage, row);
        await db.query(`
          UPDATE melobot_archive_pilot
             SET status='success', candidate=$2::jsonb, file_id=$3,
                 file_unique_id=$4, media_kind=$5, file_size=$6,
                 actual_duration_seconds=$7, audio_title=$8, audio_performer=$9,
                 completed_at=NOW(), last_error=NULL, updated_at=NOW()
           WHERE source_url=$1
        `, [
          row.source_url,
          JSON.stringify({
            artist: resolved.artist, title: resolved.title,
            rawText: resolved.rawText || null,
            sourcePopularityCount: resolved.sourcePopularityCount || null,
          }),
          media.fileId, media.fileUniqueId || null, media.kind || null,
          Number(media.fileSize || 0) || null, Number(media.duration || 0) || null,
          media.title || null, media.performer || null,
        ]);
        return { status: 'success', artist: row.artist, title: row.title };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('MeloBot exact candidates did not yield verified audio');
  } catch (err) {
    const retry = Number(row.attempts || 0) < 2;
    await db.query(`
      UPDATE melobot_archive_pilot
         SET status=$2, last_error=$3,
             completed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END,
             updated_at=NOW()
       WHERE source_url=$1
    `, [row.source_url, retry ? 'retry' : 'failed', String(err?.message || err).slice(0,1000)]);
    return { status: retry ? 'retry' : 'failed', artist: row.artist, title: row.title, error: String(err?.message || err) };
  }
}

export async function getMeloBotArchivePilotSummary() {
  await ensureSchema();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='success')::int AS success,
      COUNT(*) FILTER (WHERE status='no_confident_match')::int AS no_confident_match,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='running')::int AS running
    FROM melobot_archive_pilot
    WHERE pilot_version=$1
  `, [PILOT_VERSION]);
  return { version: PILOT_VERSION, enabled: config.melobotArchivePilotEnabled, ...(rows[0] || {}) };
}
