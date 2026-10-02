import { config } from './config.js';
import { db, bridge, tg } from './runtime.js';
import { searchMeloBot, resolveMeloBotTrackCandidate, downloadMeloBotTrackQuality } from './sources/melobot.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import { normalizeText, artistCreditCompatible, trackTitleIdentityCompatible } from './text.js';

const PILOT_VERSION = 'melobot-gap-full-v1';
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

async function captureOnce(audioMessage, row, timeoutMs = 15000) {
  const wait = bridge.expectMediaMatching(media => forwardedMatches(media, row), timeoutMs);
  try {
    await forwardHiddenToOurBot(tg, config.melobotUsername, audioMessage.id);
  } catch (err) {
    // The bridge waiter must be allowed to settle before another transfer is
    // attempted; otherwise a synchronous forwarding failure can leave the
    // single bridge slot occupied until its timeout.
    await wait.catch(() => null);
    throw err;
  }
  return wait;
}

function archiveQueryVariants(row) {
  const artist = clean(row.artist);
  const title = clean(row.title);
  const out = [];
  const add = value => {
    const query = clean(value);
    if (query && !out.includes(query)) out.push(query);
  };

  add(row.query);
  add([title, artist].filter(Boolean).join(' '));

  // Search-only simplification: MeloBot frequently indexes the base title but
  // omits featured credits from its search text. Final candidate/media
  // acceptance still validates against the original row identity.
  const baseTitle = clean(
    title
      .replace(/\s*\((?:feat\.?|ft\.?|featuring)\s+[^)]+\)\s*$/iu, '')
      .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '')
  );
  if (baseTitle && baseTitle !== title) {
    add([artist, baseTitle].filter(Boolean).join(' '));
    add([baseTitle, artist].filter(Boolean).join(' '));
    add(baseTitle);
  }

  // Some source rows use "Vs." as a collaboration credit while MeloBot may
  // index it as "vs" or simply with the punctuation removed.
  if (/\bvs\.?\b/iu.test(artist)) {
    const plainVsArtist = clean(artist.replace(/\bvs\.?\b/giu, 'vs'));
    add([plainVsArtist, baseTitle || title].filter(Boolean).join(' '));
  }

  add(title);
  return out;
}

async function capture(audioMessage, row) {
  try {
    return await captureOnce(audioMessage, row, 15000);
  } catch (err) {
    if (!/Timed out waiting for the forwarded file/i.test(String(err?.message || err))) {
      throw err;
    }

    // Telegram occasionally accepts the MTProto forward while the delivery bot
    // never observes it. Re-forwarding the same already-verified MeloBot audio
    // is idempotent for archive capture and avoids re-running search/download.
    console.warn('[melobot archive pilot] bridge timeout; retrying verified forward', {
      artist: row.artist,
      title: row.title,
      messageId: Number(audioMessage?.id || 0),
    });
    return captureOnce(audioMessage, row, 15000);
  }
}

export async function seedMeloBotArchivePilot(sourceQueue) {
  if (!config.melobotArchivePilotEnabled) return { enabled: false, queued: 0 };
  await ensureSchema();
  await db.query(`
    INSERT INTO melobot_archive_pilot (
      source_url, artist, title, expected_duration_seconds, query, pilot_version
    )
    SELECT source_url, artist, title, expected_duration_seconds,
           BTRIM(artist || ' ' || title), $2
    FROM ahangify_archive_media a
    WHERE a.status IN ('no_confident_match','failed')
      AND a.file_id IS NULL
    ORDER BY
      -- Deterministic but well-distributed sample across the unresolved archive,
      -- rather than taking the first alphabetical/source rows.
      md5(a.source_url || ':' || a.artist || ':' || a.title)
    LIMIT $1
    ON CONFLICT (source_url) DO UPDATE SET
      pilot_version = EXCLUDED.pilot_version,
      artist = EXCLUDED.artist,
      title = EXCLUDED.title,
      expected_duration_seconds = EXCLUDED.expected_duration_seconds,
      query = EXCLUDED.query,
      status = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN 'success'
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN 'pending'
        ELSE melobot_archive_pilot.status
      END,
      attempts = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN melobot_archive_pilot.attempts
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN 0
        ELSE melobot_archive_pilot.attempts
      END,
      candidate = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN melobot_archive_pilot.candidate
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN NULL
        ELSE melobot_archive_pilot.candidate
      END,
      file_id = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN melobot_archive_pilot.file_id
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN NULL
        ELSE melobot_archive_pilot.file_id
      END,
      file_unique_id = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN melobot_archive_pilot.file_unique_id
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN NULL
        ELSE melobot_archive_pilot.file_unique_id
      END,
      last_error = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN NULL
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN NULL
        ELSE melobot_archive_pilot.last_error
      END,
      completed_at = CASE
        WHEN melobot_archive_pilot.status='success' AND melobot_archive_pilot.file_id IS NOT NULL THEN melobot_archive_pilot.completed_at
        WHEN melobot_archive_pilot.pilot_version IS DISTINCT FROM EXCLUDED.pilot_version THEN NULL
        ELSE melobot_archive_pilot.completed_at
      END,
      updated_at = NOW()
  `, [config.melobotArchivePilotCount, PILOT_VERSION]);

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
    const exhaustivePass = Number(row.attempts || 0) >= 2;
    const allQueries = archiveQueryVariants(row);
    const queries = exhaustivePass ? allQueries : allQueries.slice(0, 1);

    let results = [];
    let searchError = null;
    for (const query of queries) {
      try {
        results = await searchMeloBot(tg, query, {
          timeoutMs: 12000,
          maxRefinements: exhaustivePass ? 5 : 3,
          preferredArtist: row.artist,
          allowDeepSearch: true,
        });
        if (results.some(candidate => candidateMatches(candidate, row))) break;
      } catch (err) {
        searchError = err;
      }
    }
    if (!results.length && searchError) throw searchError;
    const matches = results.filter(candidate => candidateMatches(candidate, row));
    if (!matches.length) {
      if (!exhaustivePass) {
        await db.query(`
          UPDATE melobot_archive_pilot
             SET status='retry', completed_at=NULL,
                 last_error='Fast pass found no exact candidate; queued for exhaustive pass',
                 updated_at=NOW()
           WHERE source_url=$1
        `, [row.source_url]);
        return { status: 'retry', artist: row.artist, title: row.title, reason: 'fast_pass_miss' };
      }
      await db.query(`
        UPDATE melobot_archive_pilot
           SET status='no_confident_match', completed_at=NOW(),
               last_error='No exact MeloBot artist/title candidate after exhaustive pass', updated_at=NOW()
         WHERE source_url=$1
      `, [row.source_url]);
      return { status: 'no_confident_match', artist: row.artist, title: row.title };
    }

    let lastError = null;
    for (const candidate of matches.slice(0, 3)) {
      try {
        const resolved = await resolveMeloBotTrackCandidate(tg, candidate, {
          timeoutMs: 9000,
          forceIdentity: true,
        });
        if (!candidateMatches(resolved, row)) continue;
        const result = await downloadMeloBotTrackQuality(tg, resolved, 'hq', {
          timeoutMs: 20000,
          menuTimeoutMs: 8000,
          deliveryTimeoutMs: 12000,
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
