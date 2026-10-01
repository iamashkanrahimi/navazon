import { config } from './config.js';
import { db, bridge, tg } from './runtime.js';
import { getArchiveDb } from './archiveDb.js';
import { searchAhangify, downloadAhangifyResult } from './sources/ahangify.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import { normalizeText } from './text.js';

const PILOT_VERSION = 'best-v1-50';

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

function stratumFor(row = {}) {
  const artist = clean(row.artist_display);
  const title = clean(row.title);
  if (/[&,;+]|\b(?:x|ft\.?|feat(?:uring)?)\b/i.test(artist)) return 'collaboration';
  if (variantTokens(title).length) return 'variant';
  if (Number(row.duration_seconds || 0) >= 360 || Number(row.release_year || 9999) <= 2015) {
    return 'long_or_old';
  }
  if (Number(row.release_year || 0) >= 2023) return 'recent';
  return 'simple';
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
  const accepted = artistExact && titleExact && extraVariants.length === 0 && durationOk;

  return {
    candidate,
    parsed,
    accepted,
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

  const titleCandidates = [
    rawTitle,
    parsedTitle.title,
  ].filter(Boolean);
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

  // A correctly-selected /dl_* command is already bound to an exact
  // Ahangify search result. Bridge metadata is secondary correlation evidence:
  // reject only when duration contradicts, or when both textual fields
  // positively contradict the target.
  const durationContradiction = checks.duration === false;
  const textContradictions = [checks.title, checks.artist].filter(value => value === false).length;
  const ok = !durationContradiction && textContradictions < 2;

  return { ok, checks, contradictions };
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ahangify_best_pilot (
      pilot_version TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_id TEXT,
      track_key TEXT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      expected_duration_seconds INTEGER,
      release_year INTEGER,
      stratum TEXT NOT NULL,
      query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
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
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pilot_version, source_url)
    );
    CREATE INDEX IF NOT EXISTS ahangify_best_pilot_status_idx
      ON ahangify_best_pilot (pilot_version, status, stratum);
  `);
}

async function sampleTracks(limit = 50) {
  const archiveDb = getArchiveDb();
  if (!archiveDb) throw new Error('ARCHIVE_DATABASE_URL missing for Ahangify pilot');

  const { rows } = await archiveDb.query(`
    SELECT
      source_url,
      source_id,
      artist_display,
      title,
      duration_seconds::int AS duration_seconds,
      release_year
    FROM rj_tracks
    WHERE NULLIF(BTRIM(COALESCE(artist_display,'')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(title,'')), '') IS NOT NULL
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 30
      AND duration_seconds < 1200
    ORDER BY md5(source_url)
    LIMIT 8000
  `);

  const quotas = new Map([
    ['simple', 15],
    ['collaboration', 10],
    ['variant', 10],
    ['long_or_old', 10],
    ['recent', 5],
  ]);
  const picked = [];
  const counts = new Map();

  for (const row of rows) {
    const stratum = stratumFor(row);
    const wanted = quotas.get(stratum) || 0;
    const current = counts.get(stratum) || 0;
    if (current >= wanted) continue;
    picked.push({ ...row, stratum });
    counts.set(stratum, current + 1);
    if (picked.length >= limit) break;
  }

  if (picked.length < limit) {
    const seen = new Set(picked.map(row => row.source_url));
    for (const row of rows) {
      if (seen.has(row.source_url)) continue;
      picked.push({ ...row, stratum: stratumFor(row) });
      seen.add(row.source_url);
      if (picked.length >= limit) break;
    }
  }

  if (picked.length !== limit) {
    throw new Error(`Ahangify pilot sample expected ${limit} tracks, got ${picked.length}`);
  }
  return picked;
}

async function seedRows(limit) {
  const existing = await db.query(
    'SELECT COUNT(*)::int AS n FROM ahangify_best_pilot WHERE pilot_version=$1',
    [PILOT_VERSION]
  );
  if (Number(existing.rows[0]?.n || 0) > 0) return;

  const sample = await sampleTracks(limit);
  for (const row of sample) {
    const artist = clean(row.artist_display);
    const title = clean(row.title);
    const trackKey = `${norm(artist)}|${norm(title)}`;
    const query = `${artist} ${title}`;
    await db.query(`
      INSERT INTO ahangify_best_pilot (
        pilot_version, source_url, source_id, track_key, artist, title,
        expected_duration_seconds, release_year, stratum, query, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued')
      ON CONFLICT DO NOTHING
    `, [
      PILOT_VERSION,
      row.source_url,
      row.source_id || null,
      trackKey,
      artist,
      title,
      Number(row.duration_seconds || 0) || null,
      Number(row.release_year || 0) || null,
      row.stratum,
      query,
    ]);
  }
}

export async function seedAhangifyBestPilot(sourceQueue) {
  if (!config.ahangifyBestPilotEnabled) return { enabled: false };
  await ensureSchema();
  await seedRows(config.ahangifyBestPilotCount);

  await db.query(`
    UPDATE ahangify_best_pilot
       SET status='queued',
           error=COALESCE(error,'recovered after restart'),
           updated_at=NOW()
     WHERE pilot_version=$1
       AND status='running'
  `, [PILOT_VERSION]);

  const { rows } = await db.query(`
    SELECT source_url, artist, title, expected_duration_seconds, stratum, query
    FROM ahangify_best_pilot
    WHERE pilot_version=$1
      AND status IN ('queued','retry')
      AND attempts < 3
    ORDER BY
      CASE stratum
        WHEN 'simple' THEN 1
        WHEN 'collaboration' THEN 2
        WHEN 'variant' THEN 3
        WHEN 'long_or_old' THEN 4
        WHEN 'recent' THEN 5
        ELSE 6
      END,
      source_url
    LIMIT $2
  `, [PILOT_VERSION, config.ahangifyBestPilotCount]);

  let queued = 0;
  for (const row of rows) {
    if (sourceQueue.push({
      type: 'ahangify_pilot',
      pilotVersion: PILOT_VERSION,
      sourceUrl: row.source_url,
    })) queued += 1;
  }

  console.log('[ahangify pilot] seeded', JSON.stringify({
    version: PILOT_VERSION,
    requested: config.ahangifyBestPilotCount,
    queued,
  }));
  return { enabled: true, version: PILOT_VERSION, queued };
}

async function capturePilotMedia(audioMessage, target, timeoutMs = 15000) {
  if (!audioMessage?.id) throw new Error('Ahangify audio message missing id');
  const wait = bridge.expectMediaMatching(
    media => {
      const verification = metadataMatches(media, target);
      if (!verification.ok) {
        console.warn('[ahangify pilot bridge mismatch]', JSON.stringify({
          target,
          received: {
            kind: media?.kind || null,
            title: media?.title || null,
            performer: media?.performer || null,
            duration: media?.duration || null,
            fileSize: media?.fileSize || null,
          },
          checks: verification.checks,
        }));
      }
      return verification.ok;
    },
    timeoutMs
  );
  await forwardHiddenToOurBot(tg, config.ahangifyUsername, audioMessage.id);
  return wait;
}

async function logPilotProgress(version = PILOT_VERSION) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='success')::int AS success,
      COUNT(*) FILTER (WHERE status='no_confident_match')::int AS no_confident_match,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='running')::int AS running,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 320)::int AS success_320,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 250 AND bitrate < 320)::int AS success_250_319,
      COUNT(*) FILTER (WHERE status='success' AND (bitrate IS NULL OR bitrate < 250))::int AS success_lower_or_unknown
    FROM ahangify_best_pilot
    WHERE pilot_version=$1
  `, [version]);
  const summary = rows[0] || {};
  const terminal = Number(summary.success || 0)
    + Number(summary.no_confident_match || 0)
    + Number(summary.failed || 0);
  if (terminal % 10 === 0 || terminal >= Number(summary.total || 0)) {
    console.log('[ahangify pilot progress]', JSON.stringify(summary));
  }
  if (
    Number(summary.total || 0) > 0
    && terminal >= Number(summary.total || 0)
    && Number(summary.queued || 0) === 0
    && Number(summary.running || 0) === 0
    && Number(summary.retry || 0) === 0
  ) {
    console.log('[ahangify pilot complete]', JSON.stringify(summary));
  }
}

export async function runAhangifyBestPilotJob(job) {
  const version = job?.pilotVersion || PILOT_VERSION;
  const sourceUrl = clean(job?.sourceUrl);
  if (!sourceUrl) throw new Error('Ahangify pilot job missing source URL');

  await ensureSchema();
  const claimed = await db.query(`
    UPDATE ahangify_best_pilot
       SET status='running',
           attempts=attempts+1,
           started_at=NOW(),
           error=NULL,
           updated_at=NOW()
     WHERE pilot_version=$1
       AND source_url=$2
       AND status IN ('queued','retry')
    RETURNING *
  `, [version, sourceUrl]);

  if (!claimed.rowCount) return { skipped: 'already_claimed_or_finished', sourceUrl };
  const row = claimed.rows[0];
  const target = {
    artist: row.artist,
    title: row.title,
    expectedDuration: Number(row.expected_duration_seconds || 0) || null,
  };

  let results = [];
  let assessments = [];
  try {
    results = await searchAhangify(tg, row.query, { timeoutMs: 6500 });
    assessments = results.map(candidate => candidateAssessment(candidate, target));

    await db.query(`
      UPDATE ahangify_best_pilot
         SET search_results=$3::jsonb, updated_at=NOW()
       WHERE pilot_version=$1 AND source_url=$2
    `, [
      version,
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

    const accepted = assessments.filter(item => item.accepted).sort(rankAccepted);
    if (!accepted.length) {
      await db.query(`
        UPDATE ahangify_best_pilot
           SET status='no_confident_match',
               completed_at=NOW(),
               error='No exact artist/title result within duration tolerance',
               updated_at=NOW()
         WHERE pilot_version=$1 AND source_url=$2
      `, [version, sourceUrl]);
      await logPilotProgress(version);
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
        const media = await capturePilotMedia(download.audioMessage, target, 15000);
        const verification = metadataMatches(media, target);
        if (!verification.ok) {
          lastError = new Error(
            `Forwarded media metadata contradicted target: ${verification.contradictions.join(',')}`
          );
          continue;
        }

        await db.query(`
          UPDATE ahangify_best_pilot
             SET status='success',
                 selected_candidate=$3::jsonb,
                 file_id=$4,
                 file_unique_id=$5,
                 media_kind=$6,
                 bitrate=$7,
                 file_size=$8,
                 actual_duration_seconds=$9,
                 audio_title=$10,
                 audio_performer=$11,
                 error=NULL,
                 completed_at=NOW(),
                 updated_at=NOW()
           WHERE pilot_version=$1 AND source_url=$2
        `, [
          version,
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
        ]);
        await logPilotProgress(version);

        return {
          status: 'success',
          artist: row.artist,
          title: row.title,
          bitrate: Number(chosen.bitrate || 0) || null,
          durationDelta: chosen.durationDelta,
          fileId: media.fileId,
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('All accepted Ahangify candidates failed to download');
  } catch (err) {
    const attempts = Number(row.attempts || 0);
    const retry = attempts < 3 && !/no confident match/i.test(err.message || '');
    await db.query(`
      UPDATE ahangify_best_pilot
         SET status=$3,
             error=$4,
             completed_at=CASE WHEN $3='retry' THEN NULL ELSE NOW() END,
             updated_at=NOW()
       WHERE pilot_version=$1 AND source_url=$2
    `, [
      version,
      sourceUrl,
      retry ? 'retry' : 'failed',
      String(err?.message || err).slice(0, 1000),
    ]);
    await logPilotProgress(version);

    return {
      status: retry ? 'retry' : 'failed',
      artist: row.artist,
      title: row.title,
      error: err?.message || String(err),
    };
  }
}

export async function getAhangifyBestPilotSummary() {
  await ensureSchema();
  const summary = await db.query(`
    SELECT
      status,
      stratum,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE bitrate >= 320)::int AS bitrate_320,
      COUNT(*) FILTER (WHERE bitrate >= 250 AND bitrate < 320)::int AS bitrate_250_319,
      COUNT(*) FILTER (WHERE bitrate > 0 AND bitrate < 250)::int AS bitrate_below_250
    FROM ahangify_best_pilot
    WHERE pilot_version=$1
    GROUP BY status, stratum
    ORDER BY status, stratum
  `, [PILOT_VERSION]);

  const totals = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='success')::int AS success,
      COUNT(*) FILTER (WHERE status='no_confident_match')::int AS no_confident_match,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='retry')::int AS retry,
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='running')::int AS running,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 320)::int AS success_320,
      COUNT(*) FILTER (WHERE status='success' AND bitrate >= 250 AND bitrate < 320)::int AS success_250_319,
      COUNT(*) FILTER (WHERE status='success' AND (bitrate IS NULL OR bitrate < 250))::int AS success_lower_or_unknown
    FROM ahangify_best_pilot
    WHERE pilot_version=$1
  `, [PILOT_VERSION]);

  return {
    version: PILOT_VERSION,
    totals: totals.rows[0] || {},
    breakdown: summary.rows,
  };
}
