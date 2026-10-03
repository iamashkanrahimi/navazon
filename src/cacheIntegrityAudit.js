import { db } from './db.js';
import { getArchiveDb } from './archiveDb.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 60 * 1000;

let intervalTimer = null;
let startTimer = null;
let lastSummary = null;

function numberRow(row = {}) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      /^-?\d+$/.test(String(value ?? '')) ? Number(value) : value,
    ])
  );
}

export async function runCacheIntegrityAudit({ log = true } = {}) {
  const archiveDb = getArchiveDb();
  if (!archiveDb) {
    const summary = {
      at: new Date().toISOString(),
      ok: false,
      reason: 'archive_db_missing',
    };
    lastSummary = summary;
    if (log) console.warn('[cache integrity audit]', JSON.stringify(summary));
    return summary;
  }

  const [
    archiveAudioResult,
    archiveImageResult,
    productionMediaResult,
    productionTrackCacheResult,
    productionCoverResult,
  ] = await Promise.all([
    archiveDb.query(`
      WITH duplicate_audio AS (
        SELECT telegram_file_unique_id
        FROM rj_audio_cache
        WHERE status='cached'
          AND telegram_file_unique_id IS NOT NULL
        GROUP BY telegram_file_unique_id
        HAVING COUNT(DISTINCT source_url) > 1
      )
      SELECT
        COUNT(*) FILTER (WHERE status='cached')::int AS cached,
        COUNT(*) FILTER (
          WHERE status='cached' AND telegram_file_id IS NULL
        )::int AS missing_file_id,
        COUNT(*) FILTER (
          WHERE status='cached' AND telegram_file_unique_id IS NULL
        )::int AS missing_unique_id,
        COUNT(*) FILTER (
          WHERE status='cached' AND canonicalized_at IS NULL
        )::int AS not_canonicalized,
        COUNT(*) FILTER (
          WHERE status='cached'
            AND expected_duration_seconds IS NOT NULL
            AND actual_duration_seconds IS NOT NULL
            AND ABS(expected_duration_seconds-actual_duration_seconds) > 12
        )::int AS duration_bad,
        COUNT(*) FILTER (
          WHERE status='cached'
            AND (
              verification->>'titleOk'='false'
              OR verification->>'artistOk'='false'
            )
        )::int AS legacy_identity_flagged,
        COUNT(*) FILTER (
          WHERE status='cached'
            AND (verification->>'titleOk') IS NULL
            AND (verification->>'artistOk') IS NULL
            AND (
              expected_duration_seconds IS NULL
              OR actual_duration_seconds IS NULL
              OR ABS(expected_duration_seconds-actual_duration_seconds) > 3
            )
        )::int AS unsafe_metadata_light,
        (SELECT COUNT(*)::int FROM duplicate_audio) AS duplicate_unique_id_groups
      FROM rj_audio_cache
    `),
    archiveDb.query(`
      WITH duplicate_images AS (
        SELECT telegram_file_unique_id
        FROM media_images
        WHERE status='cached'
          AND telegram_file_unique_id IS NOT NULL
        GROUP BY telegram_file_unique_id
        HAVING COUNT(DISTINCT source_url) > 1
      )
      SELECT
        COUNT(*) FILTER (WHERE status='cached')::int AS cached,
        COUNT(*) FILTER (
          WHERE status='cached' AND telegram_file_id IS NULL
        )::int AS missing_file_id,
        COUNT(*) FILTER (
          WHERE status='cached' AND telegram_file_unique_id IS NULL
        )::int AS missing_unique_id,
        (SELECT COUNT(*)::int FROM duplicate_images) AS duplicate_unique_id_groups
      FROM media_images
    `),
    db.query(`
      WITH duplicate_rj_media AS (
        SELECT file_unique_id
        FROM deep_track_media
        WHERE source='identity-v2:radiojavan'
          AND verified_quality=TRUE
          AND file_unique_id IS NOT NULL
        GROUP BY file_unique_id
        HAVING COUNT(DISTINCT track_key) > 1
      )
      SELECT
        COUNT(*) FILTER (
          WHERE source='identity-v2:radiojavan'
        )::int AS rj_media,
        COUNT(*) FILTER (
          WHERE source='identity-v2:radiojavan'
            AND file_id IS NULL
        )::int AS missing_file_id,
        COUNT(*) FILTER (
          WHERE source='identity-v2:radiojavan'
            AND file_unique_id IS NULL
        )::int AS missing_unique_id,
        COUNT(*) FILTER (
          WHERE source='identity-v2:radiojavan'
            AND kind <> 'audio'
        )::int AS non_audio,
        (SELECT COUNT(*)::int FROM duplicate_rj_media) AS duplicate_unique_id_groups
      FROM deep_track_media
    `),
    db.query(`
      SELECT
        COUNT(*)::int AS rj_verified_direct,
        COUNT(*) FILTER (
          WHERE COALESCE(media->>'identityVerified','false') <> 'true'
        )::int AS legacy_without_identity_marker,
        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(COALESCE(media->>'fileId','')), '') IS NULL
        )::int AS missing_file_id
      FROM track_cache
      WHERE COALESCE(track->>'source','')='radiojavan'
        AND COALESCE(media->>'verifiedDirect','false')='true'
        AND active=TRUE
    `),
    db.query(`
      WITH cross_artist_cover AS (
        SELECT cover_unique_id
        FROM deep_tracks
        WHERE cover_unique_id IS NOT NULL
        GROUP BY cover_unique_id
        HAVING COUNT(DISTINCT LOWER(BTRIM(artist))) > 1
      )
      SELECT
        COUNT(*) FILTER (WHERE cover_file_id IS NOT NULL)::int AS tracks_with_cover,
        COUNT(*) FILTER (
          WHERE cover_file_id IS NOT NULL AND cover_unique_id IS NULL
        )::int AS missing_unique_id,
        (SELECT COUNT(*)::int FROM cross_artist_cover) AS cross_artist_duplicate_groups
      FROM deep_tracks
    `),
  ]);

  const archiveAudio = numberRow(archiveAudioResult.rows[0]);
  const archiveImages = numberRow(archiveImageResult.rows[0]);
  const productionMedia = numberRow(productionMediaResult.rows[0]);
  const productionTrackCache = numberRow(productionTrackCacheResult.rows[0]);
  const productionCovers = numberRow(productionCoverResult.rows[0]);

  const criticalIssues = [
    archiveAudio.missing_file_id,
    archiveAudio.missing_unique_id,
    archiveAudio.not_canonicalized,
    archiveAudio.duration_bad,
    archiveAudio.unsafe_metadata_light,
    archiveAudio.duplicate_unique_id_groups,
    archiveImages.missing_file_id,
    archiveImages.missing_unique_id,
    archiveImages.duplicate_unique_id_groups,
    productionMedia.missing_file_id,
    productionMedia.missing_unique_id,
    productionMedia.non_audio,
    productionMedia.duplicate_unique_id_groups,
    productionTrackCache.missing_file_id,
    productionCovers.missing_unique_id,
    productionCovers.cross_artist_duplicate_groups,
  ].reduce((sum, value) => sum + Number(value || 0), 0);

  const reviewFlags = Number(archiveAudio.legacy_identity_flagged || 0);

  const summary = {
    at: new Date().toISOString(),
    ok: criticalIssues === 0,
    criticalIssues,
    reviewFlags,
    archiveAudio,
    archiveImages,
    productionMedia,
    productionTrackCache,
    productionCovers,
  };
  lastSummary = summary;

  if (log) {
    const method = criticalIssues > 0 || reviewFlags > 0 ? 'warn' : 'log';
    console[method]('[cache integrity audit]', JSON.stringify(summary));
  }
  return summary;
}

export function getLastCacheIntegrityAudit() {
  return lastSummary;
}

export function startCacheIntegrityAuditScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  startDelayMs = DEFAULT_START_DELAY_MS,
} = {}) {
  if (intervalTimer || startTimer) return;

  const run = () => {
    void runCacheIntegrityAudit().catch(err => {
      console.error('[cache integrity audit]', err?.stack || err?.message || err);
    });
  };

  startTimer = setTimeout(() => {
    startTimer = null;
    run();
    intervalTimer = setInterval(run, Math.max(60_000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    intervalTimer.unref?.();
  }, Math.max(5_000, Number(startDelayMs) || DEFAULT_START_DELAY_MS));
  startTimer.unref?.();
}

export function stopCacheIntegrityAuditScheduler() {
  if (startTimer) clearTimeout(startTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startTimer = null;
  intervalTimer = null;
}
