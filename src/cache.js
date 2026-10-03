import { db } from './db.js';
import { applyPolicyDefaults } from './policy.js';
import {
  normalizeText,
  stableSourceTrackVariant,
  trackMediaIdentityMatches,
  hasMediaIdentityEvidence,
} from './text.js';

function normalize(value = '') {
  return normalizeText(value);
}

function stableVariant(track = {}) {
  const value = String(
    track.rawText || track.cmd || track.duration || track.bitrate || ''
  );
  return track.rawText
    ? stableSourceTrackVariant(value)
    : normalize(value);
}

export function trackCacheKey(track = {}) {
  const artist = normalize(track.artist || '');
  const title = normalize(track.title || '');
  return `${artist}|${title}|${stableVariant(track)}`;
}

function hasCacheableTrackIdentity(track = {}) {
  return Boolean(
    !track?.artistInferred
    && normalize(track?.artist || '')
    && normalize(track?.title || '')
  );
}

export function isTrustedRadioJavanMedia(track = {}, media = {}) {
  if (String(track?.source || '') !== 'radiojavan') return false;
  return media?.verifiedDirect === true && media?.identityVerified === true;
}

function cachedMediaMayBeServed(track = {}, media = {}) {
  if (String(track?.source || '') !== 'radiojavan') return true;
  return isTrustedRadioJavanMedia(track, media);
}

export class FileCache {
  async load() {}

  async get(track) {
    if (!hasCacheableTrackIdentity(track)) return null;
    const key = trackCacheKey(track);
    const artist = normalize(track?.artist || '');
    const title = normalize(track?.title || '');
    const prefix = `${artist}|${title}|`;

    // Radio Javan direct media is canonical once verified. This query always
    // checks the whole Artist/Title identity family instead of returning an
    // exact older MeloBot/Ahangify variant first.
    const result = await db.query(`
      SELECT track_key, track, media
      FROM track_cache
      WHERE LEFT(track_key, LENGTH($1)) = $1
        AND active = TRUE
        AND (
          COALESCE(track->>'source','') <> 'radiojavan'
          OR (
            COALESCE(media->>'verifiedDirect','false') = 'true'
            AND COALESCE(media->>'identityVerified','false') = 'true'
          )
        )
      ORDER BY
        CASE
          WHEN COALESCE(track->>'source','') = 'radiojavan'
           AND COALESCE(media->>'verifiedDirect','false') = 'true'
           AND COALESCE(media->>'identityVerified','false') = 'true' THEN 0
          WHEN track_key = $2 THEN 1
          WHEN COALESCE(track->>'source','') = $3 THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT 1
    `, [prefix, key, String(track?.source || '')]);

    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (!cachedMediaMayBeServed(row.track || {}, row.media || {})) {
      console.warn('[file cache untrusted radiojavan]', track?.artist, track?.title);
      return null;
    }
    if (!hasMediaIdentityEvidence(row.media || {})) {
      console.warn('[file cache stale identity]', track?.artist, track?.title);
      return null;
    }
    const identityProbe = {
      performer: row.media.performer,
      title: row.media.title,
    };
    if (!trackMediaIdentityMatches(track, identityProbe)) {
      console.warn(
        '[file cache identity mismatch]',
        track?.artist,
        track?.title,
        '!=',
        identityProbe.performer,
        identityProbe.title
      );
      return null;
    }
    return {
      ...row.media,
      ...row.track,
      _cacheKey: row.track_key,
    };
  }

  async set(track, media, { sourceFetch = true } = {}) {
    const policy = applyPolicyDefaults(track);
    if (!hasCacheableTrackIdentity(policy)) return;
    if (
      String(policy?.source || '') === 'radiojavan'
      && !isTrustedRadioJavanMedia(policy, media || {})
    ) {
      console.warn('[file cache radiojavan write rejected]', policy.artist, policy.title);
      return;
    }
    if (
      !hasMediaIdentityEvidence(media)
      || !trackMediaIdentityMatches(policy, media || {})
    ) {
      console.warn('[file cache write rejected]', policy.artist, policy.title);
      return;
    }
    const key = trackCacheKey(policy);
    if (!key || key === '||') return;
    const compact = {
      artist: policy.artist || '',
      title: policy.title || '',
      source: policy.source || undefined,
      variant: policy.rawText || policy.cmd || undefined,
      sourcePopularityText: policy.sourcePopularityText || undefined,
      sourcePopularityCount: Number.isFinite(policy.sourcePopularityCount) ? policy.sourcePopularityCount : undefined,
      contentOrigin: policy.contentOrigin,
      availabilityPolicy: policy.availabilityPolicy,
      restrictionSource: policy.restrictionSource,
      restrictionReason: policy.restrictionReason,
      availabilityUpdatedAt: policy.availabilityUpdatedAt,
    };
    await db.query(`
      INSERT INTO track_cache (track_key, track, media, source_fetch_count)
      VALUES ($1, $2::jsonb, $3::jsonb, $4)
      ON CONFLICT (track_key) DO UPDATE SET
        track = EXCLUDED.track,
        media = EXCLUDED.media,
        source_fetch_count = track_cache.source_fetch_count + EXCLUDED.source_fetch_count,
        updated_at = NOW()
    `, [key, JSON.stringify(compact), JSON.stringify(media), sourceFetch ? 1 : 0]);

    const artist = normalize(policy.artist || '');
    const title = normalize(policy.title || '');
    const prefix = `${artist}|${title}|`;
    const canonicalRj = isTrustedRadioJavanMedia(policy, media || {});

    if (canonicalRj) {
      // Keep historical source rows for audit/recovery, but make them
      // impossible to serve while a verified Radio Javan direct copy exists.
      await db.query(`
        UPDATE track_cache
        SET active = (track_key = $2),
            superseded_by = CASE WHEN track_key = $2 THEN NULL ELSE $2 END,
            updated_at = CASE WHEN track_key = $2 THEN NOW() ELSE updated_at END
        WHERE LEFT(track_key, LENGTH($1)) = $1
      `, [prefix, key]);
      return;
    }

    // A later MeloBot/Ahangify write must never reactivate itself over an
    // already-verified Radio Javan canonical file.
    const canonical = await db.query(`
      SELECT track_key
      FROM track_cache
      WHERE LEFT(track_key, LENGTH($1)) = $1
        AND COALESCE(track->>'source','') = 'radiojavan'
        AND COALESCE(media->>'verifiedDirect','false') = 'true'
        AND COALESCE(media->>'identityVerified','false') = 'true'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [prefix]);
    const canonicalKey = canonical.rows[0]?.track_key || null;
    if (canonicalKey && canonicalKey !== key) {
      await db.query(`
        UPDATE track_cache
        SET active = FALSE, superseded_by = $2
        WHERE track_key = $1
      `, [key, canonicalKey]);
    }
  }

  async recordSourceFetch(track) {
    if (!hasCacheableTrackIdentity(track)) return;
    await db.query(
      'UPDATE track_cache SET source_fetch_count = source_fetch_count + 1, updated_at = NOW() WHERE track_key = $1',
      [trackCacheKey(track)]
    );
  }

  async recordServe(track, { cacheHit = false, cacheKey = null } = {}) {
    if (!hasCacheableTrackIdentity(track)) return;
    const key = cacheKey || trackCacheKey(track);
    await db.query(`
      UPDATE track_cache SET
        navazon_serve_count = navazon_serve_count + 1,
        cache_hit_count = cache_hit_count + $2,
        last_served_at = NOW(),
        updated_at = NOW()
      WHERE track_key = $1
    `, [key, cacheHit ? 1 : 0]);
  }

  async has(track) {
    return Boolean(await this.get(track));
  }
}
