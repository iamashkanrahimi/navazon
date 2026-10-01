import { config } from './config.js';
import { db, bridge, tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { searchAhangify, downloadAhangifyResult } from './sources/ahangify.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import { normalizeText } from './text.js';

const ARCHIVE_VERSION = 'archive-v1';
let pumpTimer = null;
let pumpBusy = false;
let floodPauseUntilMs = 0;

function parseFloodWaitSeconds(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || '');
  const human = message.match(/A wait of\s+(\d+)\s+seconds?\s+is required/i);
  if (human) return Number(human[1]) || 0;
  const rpc = message.match(/FLOOD_WAIT[_\s-]?(\d+)/i);
  if (rpc) return Number(rpc[1]) || 0;
  return 0;
}

function floodPauseRemainingMs() {
  return Math.max(0, floodPauseUntilMs - Date.now());
}

function applyFloodPause(seconds) {
  const waitSeconds = Math.max(1, Number(seconds || 0));
  const marginSeconds = 5;
  const nextUntil = Date.now() + (waitSeconds + marginSeconds) * 1000;
  if (nextUntil > floodPauseUntilMs) floodPauseUntilMs = nextUntil;
  const remainingSeconds = Math.ceil(floodPauseRemainingMs() / 1000);
  console.warn('[ahangify archive cooldown]', JSON.stringify({
    flood_wait_seconds: waitSeconds,
    margin_seconds: marginSeconds,
    resume_in_seconds: remainingSeconds,
    resume_at: new Date(floodPauseUntilMs).toISOString(),
  }));
  return remainingSeconds;
}

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value = '') {
  return normalizeText(clean(value));
}

function splitCandidateLabel(value = '') {
  const text = clean(value);
  const match = text.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (!match) return { artist: '', title: text };
  return { artist: clean(match[1]), title: clean(match[2]) };
}

function creditParts(value = '') {
  const raw = clean(value)
    .replace(/\b(?:feat(?:uring)?|ft)\.?\b/gi, ' x ')
    .replace(/[&,;+]/g, ' x ');
  const parts = raw
    .split(/\s+\bx\b\s+/i)
    .map(part => norm(part))
    .filter(Boolean);
  return [...new Set(parts)].sort();
}

function sameCredits(a = '', b = '') {
  const aa = creditParts(a);
  const bb = creditParts(b);
  return aa.length > 0
    && aa.length === bb.length
    && aa.every((part, index) => part === bb[index]);
}

function parseDuration(value = '') {
  const parts = String(value || '').split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function variantTokens(value = '') {
  const text = norm(value);
  const tokens = [
    'remix', 'mix', 'live', 'acoustic', 'version', 'edit', 'beat',
    'instrumental', 'slowed', 'sped up', 'radio edit', 'mashup', 'cover'
  ];
  return tokens.filter(token => text.includes(norm(token)));
}

function candidateAssessment(candidate, target) {
  const parsed = splitCandidateLabel(candidate.title);
  const artistExact = sameCredits(parsed.artist, target.artist);
  const titleExact = norm(parsed.title) === norm(target.title);
  const expectedVariants = variantTokens(target.title);
  const candidateVariants = variantTokens(parsed.title);
  const extraVariants = candidateVariants.filter(token => !expectedVariants.includes(token));
  const durationSeconds = parseDuration(candidate.duration);
  const expectedDuration = Number(target.expectedDuration || 0) || null;
  const durationDelta = expectedDuration && durationSeconds != null
    ? Math.abs(durationSeconds - expectedDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;

  return {
    candidate,
    parsed,
    accepted: artistExact && titleExact && extraVariants.length === 0 && durationOk,
    artistExact,
    titleExact,
    extraVariants,
    durationSeconds,
    durationDelta,
    bitrate: Number(candidate.bitrate || 0) || null,
  };
}

function rankAccepted(a, b) {
  const bitrateA = Number(a.bitrate || 0);
  const bitrateB = Number(b.bitrate || 0);
  if (bitrateA !== bitrateB) return bitrateB - bitrateA;

  const deltaA = a.durationDelta == null ? 99999 : a.durationDelta;
  const deltaB = b.durationDelta == null ? 99999 : b.durationDelta;
  if (deltaA !== deltaB) return deltaA - deltaB;

  return Number(a.candidate?.rank || 999) - Number(b.candidate?.rank || 999);
}

function coreTitle(value = '') {
  return norm(
    clean(value)
      .replace(/\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\b[^\)\]]*[\)\]]/gi, ' ')
      .replace(/\s+-\s+(?:ft\.?|feat\.?|featuring)\b.*$/gi, ' ')
  );
}

function metadataMatches(media, target) {
  const targetCredits = creditParts(target.artist);
  const rawTitle = clean(media?.title || '');
  const parsedTitle = rawTitle ? splitCandidateLabel(rawTitle) : { artist: '', title: '' };

  const titleCandidates = [rawTitle, parsedTitle.title].filter(Boolean);
  const titleOk = !titleCandidates.length
    ? null
    : titleCandidates.some(value => coreTitle(value) === coreTitle(target.title));

  const artistEvidence = [
    clean(media?.performer || ''),
    clean(parsedTitle.artist || ''),
  ].filter(Boolean);

  let artistOk = null;
  if (artistEvidence.length) {
    artistOk = artistEvidence.some(value => {
      const mediaCredits = creditParts(value);
      if (!mediaCredits.length || !targetCredits.length) return false;
      return targetCredits.length <= 1
        ? mediaCredits.includes(targetCredits[0])
        : mediaCredits.some(part => targetCredits.includes(part));
    });
  }

  const checks = {
    title: titleOk,
    artist: artistOk,
    duration: media?.duration && target.expectedDuration
      ? Math.abs(Number(media.duration) - Number(target.expectedDuration)) <= 12
      : null,
  };

  const contradictions = Object.entries(checks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);

  const durationContradiction = checks.duration === false;
  const textContradictions = [checks.title, checks.artist].filter(value => value === false).length;

  return {
    ok: !durationContradiction && textContradictions < 2,
    checks,
    contradictions,
  };
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ahangify_archive_media (
      source_url TEXT PRIMARY KEY,
      source_id TEXT,
      track_key TEXT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      expected_duration_seconds INTEGER,
      release_year INTEGER,
      query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      search_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      selected_candidate JSONB,
      file_id TEXT,
      file_unique_id TEXT,
      media_kind TEXT,
      bitrate INTEGER,
      file_size BIGINT,
      actual_duration_seconds INTEGER,
      audio_title TEXT,
      audio_performer TEXT,
      source TEXT NOT NULL DEFAULT 'ahangify',
      worker_version TEXT NOT NULL DEFAULT '${ARCHIVE_VERSION}',
      first_success_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS ahangify_archive_media_status_idx
      ON ahangify_archive_media (status, next_attempt_at, attempts, source_url);

    CREATE INDEX IF NOT EXISTS ahangify_archive_media_bitrate_idx
      ON ahangify_archive_media (bitrate DESC NULLS LAST)
      WHERE file_id IS NOT NULL;
  `);
}

async function seedAllTracks() {
  const archiveDb = getArchiveDb();
  if (!archiveDb) throw new Error('ARCHIVE_DATABASE_URL missing for Ahangify archive worker');

  const { rows } = await archiveDb.query(`
    SELECT
      source_url,
      source_id,
      artist_display,
      title,
      duration_seconds::int AS duration_seconds,
      release_year
    FROM rj_tracks
    WHERE NULLIF(BTRIM(COALESCE(source_url,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(artist_display,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(title,'')), '') IS NOT NULL
    ORDER BY source_url
  `);

  const chunkSize = 500;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    await db.query(`
      INSERT INTO ahangify_archive_media (
        source_url, source_id, track_key, artist, title,
        expected_duration_seconds, release_year, query
      )
      SELECT *
      FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::int[],
        $7::int[],
        $8::text[]
      )
      ON CONFLICT (source_url) DO UPDATE SET
        source_id = EXCLUDED.source_id,
        track_key = EXCLUDED.track_key,
        artist = EXCLUDED.artist,
        title = EXCLUDED.title,
        expected_duration_seconds = EXCLUDED.expected_duration_seconds,
        release_year = EXCLUDED.release_year,
        query = EXCLUDED.query,
        updated_at = NOW()
    `, [
      chunk.map(row => row.source_url),
      chunk.map(row => row.source_id || null),
      chunk.map(row => `${norm(row.artist_display)}|${norm(row.title)}`),
      chunk.map(row => clean(row.artist_display)),
      chunk.map(row => clean(row.title)),
      chunk.map(row => Number(row.duration_seconds || 0) || null),
      chunk.map(row => Number(row.release_year || 0) || null),
      chunk.map(row => `${clean(row.artist_display)} ${clean(row.title)}`),
    ]);
  }

  await db.query(`
    UPDATE ahangify_archive_media
       SET status='retry',
           next_attempt_at=NOW(),
           last_error=COALESCE(last_error, 'recovered after restart'),
           updated_at=NOW()
     WHERE status='running'
       AND updated_at < NOW() - INTERVAL '5 minutes'
  `);

  const pilotExists = await db.query(
    `SELECT to_regclass('public.ahangify_best_pilot') AS table_name`
  );
  if (pilotExists.rows[0]?.table_name) {
    await db.query(`
      UPDATE ahangify_archive_media a
         SET status='success',
             attempts=GREATEST(a.attempts, p.attempts),
             search_results=p.search_results,
             selected_candidate=p.selected_candidate,
             file_id=p.file_id,
             file_unique_id=p.file_unique_id,
             media_kind=p.media_kind,
             bitrate=p.bitrate,
             file_size=p.file_size,
             actual_duration_seconds=p.actual_duration_seconds,
             audio_title=p.audio_title,
             audio_performer=p.audio_performer,
             first_success_at=COALESCE(a.first_success_at, p.completed_at, NOW()),
             completed_at=COALESCE(p.completed_at, NOW()),
             next_attempt_at=NULL,
             last_error=NULL,
             updated_at=NOW()
        FROM ahangify_best_pilot p
       WHERE p.pilot_version='best-v2-50'
         AND p.status='success'
         AND p.file_id IS NOT NULL
         AND p.source_url=a.source_url
         AND a.file_id IS NULL
    `);
  }

  return rows.length;
}

export async function enqueueAhangifyArchiveBatch(sourceQueue, limit = config.ahangifyArchiveBatchSize) {
  if (!config.ahangifyArchiveEnabled) return { enabled: false, queued: 0 };
  const pausedMs = floodPauseRemainingMs();
  if (pausedMs > 0) {
    return {
      enabled: true,
      queued: 0,
      paused: true,
      resume_in_seconds: Math.ceil(pausedMs / 1000),
    };
  }
  await ensureSchema();

  const { rows } = await db.query(`
    SELECT source_url
    FROM ahangify_archive_media
    WHERE (
      status='pending'
      OR (
        status='retry'
        AND COALESCE(next_attempt_at, NOW()) <= NOW()
      )
    )
      AND attempts < $1
    ORDER BY
      CASE status WHEN 'retry' THEN 0 ELSE 1 END,
      attempts,
      source_url
    LIMIT $2
  `, [config.ahangifyArchiveMaxAttempts, Math.max(1, Number(limit || 1))]);

  let queued = 0;
  for (const row of rows) {
    if (sourceQueue.push({
      type: 'ahangify_archive',
      sourceUrl: row.source_url,
      workerVersion: ARCHIVE_VERSION,
    })) queued += 1;
  }
  return { enabled: true, queued };
}

async function captureArchiveMedia(audioMessage, target, timeoutMs = 15000) {
  if (!audioMessage?.id) throw new Error('Ahangify audio message missing id');

  const wait = bridge.expectMediaMatching(
    media => metadataMatches(media, target).ok,
    timeoutMs
  );
  await forwardHiddenToOurBot(tg, config.ahangifyUsername, audioMessage.id);
  return wait;
}

async function logProgress() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='success')::int AS success,
      COUNT(*) FILTER (WHERE status='no_confident_match')::int AS no_confident_match,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='running')::int AS running,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 320)::int AS success_320,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 250 AND bitrate < 320)::int AS success_250_319,
      COUNT(*) FILTER (WHERE status='success' AND bitrate IS NULL)::int AS success_unknown_bitrate,
      COUNT(*) FILTER (WHERE status='success' AND bitrate > 0 AND bitrate < 250)::int AS success_below_250
    FROM ahangify_archive_media
  `);
  const summary = rows[0] || {};
  const terminal = Number(summary.success || 0)
    + Number(summary.no_confident_match || 0)
    + Number(summary.failed || 0);

  if (terminal % 100 === 0 || terminal >= Number(summary.total || 0)) {
    console.log('[ahangify archive progress]', JSON.stringify(summary));
  }
  return summary;
}

export async function runAhangifyArchiveJob(job) {
  const sourceUrl = clean(job?.sourceUrl);
  if (!sourceUrl) throw new Error('Ahangify archive job missing source URL');

  const pausedMs = floodPauseRemainingMs();
  if (pausedMs > 0) {
    return {
      status: 'paused',
      sourceUrl,
      resume_in_seconds: Math.ceil(pausedMs / 1000),
    };
  }

  await ensureSchema();
  const claimed = await db.query(`
    UPDATE ahangify_archive_media
       SET status='running',
           attempts=attempts+1,
           next_attempt_at=NULL,
           last_error=NULL,
           updated_at=NOW()
     WHERE source_url=$1
       AND status IN ('pending','retry')
       AND attempts < $2
    RETURNING *
  `, [sourceUrl, config.ahangifyArchiveMaxAttempts]);

  if (!claimed.rowCount) return { status: 'skipped', sourceUrl };

  const row = claimed.rows[0];
  const target = {
    artist: row.artist,
    title: row.title,
    expectedDuration: Number(row.expected_duration_seconds || 0) || null,
  };

  try {
    const results = await searchAhangify(tg, row.query, { timeoutMs: 6500 });
    const assessments = results.map(candidate => candidateAssessment(candidate, target));

    await db.query(`
      UPDATE ahangify_archive_media
         SET search_results=$2::jsonb,
             updated_at=NOW()
       WHERE source_url=$1
    `, [
      sourceUrl,
      JSON.stringify(assessments.map(item => ({
        rank: item.candidate.rank,
        title: item.candidate.title,
        cmd: item.candidate.cmd,
        duration: item.candidate.duration || null,
        size: item.candidate.size || null,
        bitrate: item.bitrate,
        accepted: item.accepted,
        artistExact: item.artistExact,
        titleExact: item.titleExact,
        extraVariants: item.extraVariants,
        durationSeconds: item.durationSeconds,
        durationDelta: item.durationDelta,
      }))),
    ]);

    // Bitrate is never a validity gate. Unknown or low bitrate is acceptable
    // when identity checks pass; a later upgrade pass can replace the file_id.
    const accepted = assessments.filter(item => item.accepted).sort(rankAccepted);
    if (!accepted.length) {
      await db.query(`
        UPDATE ahangify_archive_media
           SET status='no_confident_match',
               completed_at=NOW(),
               last_error='No exact artist/title result within duration tolerance',
               updated_at=NOW()
         WHERE source_url=$1
      `, [sourceUrl]);
      await logProgress();
      return {
        status: 'no_confident_match',
        artist: row.artist,
        title: row.title,
        candidates: results.length,
      };
    }

    let lastError = null;
    for (const chosen of accepted.slice(0, 3)) {
      try {
        const download = await downloadAhangifyResult(
          tg,
          chosen.candidate,
          { timeoutMs: 9000 }
        );
        const media = await captureArchiveMedia(download.audioMessage, target, 15000);
        const verification = metadataMatches(media, target);
        if (!verification.ok) {
          lastError = new Error(
            `Forwarded media metadata contradicted target: ${verification.contradictions.join(',')}`
          );
          continue;
        }

        await db.query(`
          UPDATE ahangify_archive_media
             SET status='success',
                 selected_candidate=$2::jsonb,
                 file_id=$3,
                 file_unique_id=$4,
                 media_kind=$5,
                 bitrate=$6,
                 file_size=$7,
                 actual_duration_seconds=$8,
                 audio_title=$9,
                 audio_performer=$10,
                 first_success_at=COALESCE(first_success_at, NOW()),
                 completed_at=NOW(),
                 next_attempt_at=NULL,
                 last_error=NULL,
                 worker_version=$11,
                 updated_at=NOW()
           WHERE source_url=$1
        `, [
          sourceUrl,
          JSON.stringify({
            rank: chosen.candidate.rank,
            title: chosen.candidate.title,
            cmd: chosen.candidate.cmd,
            duration: chosen.candidate.duration || null,
            size: chosen.candidate.size || null,
            bitrate: chosen.bitrate,
            durationDelta: chosen.durationDelta,
            metadataVerification: verification,
          }),
          media.fileId,
          media.fileUniqueId || null,
          media.kind || null,
          Number(chosen.bitrate || 0) || null,
          Number(media.fileSize || 0) || null,
          Number(media.duration || 0) || chosen.durationSeconds || null,
          media.title || null,
          media.performer || null,
          ARCHIVE_VERSION,
        ]);

        await logProgress();
        return {
          status: 'success',
          artist: row.artist,
          title: row.title,
          bitrate: Number(chosen.bitrate || 0) || null,
          durationDelta: chosen.durationDelta,
          fileId: media.fileId,
        };
      } catch (err) {
        if (parseFloodWaitSeconds(err) > 0) throw err;
        lastError = err;
      }
    }

    throw lastError || new Error('All accepted Ahangify candidates failed to download');
  } catch (err) {
    const attempts = Number(row.attempts || 0);
    const message = String(err?.message || err);
    const floodWaitSeconds = parseFloodWaitSeconds(message);

    if (floodWaitSeconds > 0) {
      const resumeInSeconds = applyFloodPause(floodWaitSeconds);
      await db.query(`
        UPDATE ahangify_archive_media
           SET status='retry',
               attempts=GREATEST(attempts - 1, 0),
               last_error=$2,
               next_attempt_at=NOW() + ($3 * INTERVAL '1 second'),
               completed_at=NULL,
               updated_at=NOW()
         WHERE source_url=$1
      `, [sourceUrl, message.slice(0, 1000), resumeInSeconds]);

      return {
        status: 'flood_wait',
        artist: row.artist,
        title: row.title,
        resume_in_seconds: resumeInSeconds,
        error: message,
      };
    }

    const terminalNoMatch = /Ahangify search returned no usable result/i.test(message)
      && /(هیچ نتیجه|کپی.?رایت|copyright|no usable result)/i.test(message);
    const retry = !terminalNoMatch && attempts < config.ahangifyArchiveMaxAttempts;
    const status = terminalNoMatch
      ? 'no_confident_match'
      : (retry ? 'retry' : 'failed');

    await db.query(`
      UPDATE ahangify_archive_media
         SET status=$2,
             last_error=$3,
             next_attempt_at=CASE WHEN $2='retry' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
             completed_at=CASE WHEN $2='retry' THEN NULL ELSE NOW() END,
             updated_at=NOW()
       WHERE source_url=$1
    `, [sourceUrl, status, message.slice(0, 1000)]);

    await logProgress();
    return {
      status,
      artist: row.artist,
      title: row.title,
      error: message,
    };
  }
}

export async function getAhangifyArchiveSummary() {
  await ensureSchema();
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='success')::int AS success,
      COUNT(*) FILTER (WHERE status='no_confident_match')::int AS no_confident_match,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='running')::int AS running,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 320)::int AS success_320,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 250 AND bitrate < 320)::int AS success_250_319,
      COUNT(*) FILTER (WHERE status='success' AND bitrate IS NULL)::int AS success_unknown_bitrate,
      COUNT(*) FILTER (WHERE status='success' AND bitrate > 0 AND bitrate < 250)::int AS success_below_250,
      MIN(updated_at) FILTER (WHERE status='pending') AS oldest_pending_updated_at,
      MAX(completed_at) AS last_completed_at
    FROM ahangify_archive_media
  `);

  return {
    version: ARCHIVE_VERSION,
    enabled: config.ahangifyArchiveEnabled,
    flood_pause_active: floodPauseRemainingMs() > 0,
    flood_pause_remaining_seconds: Math.ceil(floodPauseRemainingMs() / 1000),
    flood_pause_until: floodPauseRemainingMs() > 0
      ? new Date(floodPauseUntilMs).toISOString()
      : null,
    ...rows[0],
  };
}

export async function startAhangifyArchivePump(sourceQueue) {
  if (!config.ahangifyArchiveEnabled) return { enabled: false };

  await ensureSchema();
  const seeded = await seedAllTracks();
  const initial = await enqueueAhangifyArchiveBatch(sourceQueue);

  if (!pumpTimer) {
    pumpTimer = setInterval(() => {
      if (pumpBusy) return;
      if (sourceQueue.pendingSize() >= config.ahangifyArchiveBatchSize * 2) return;

      pumpBusy = true;
      enqueueAhangifyArchiveBatch(sourceQueue)
        .catch(err => console.warn('[ahangify archive pump]', err?.message || err))
        .finally(() => { pumpBusy = false; });
    }, config.ahangifyArchivePumpMs);
    pumpTimer.unref?.();
  }

  return {
    enabled: true,
    version: ARCHIVE_VERSION,
    seeded,
    queued: initial.queued,
  };
}

export function stopAhangifyArchivePump() {
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
  pumpBusy = false;
}
