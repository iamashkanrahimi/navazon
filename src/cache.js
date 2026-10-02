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

export class FileCache {
  async load() {}

  async get(track) {
    if (!hasCacheableTrackIdentity(track)) return null;
    const key = trackCacheKey(track);
    let result = await db.query(
      'SELECT track_key, track, media FROM track_cache WHERE track_key = $1',
      [key]
    );

    if (!result.rowCount) {
      const artist = normalize(track?.artist || '');
      const title = normalize(track?.title || '');
      if (artist || title) {
        const prefix = `${artist}|${title}|%`;
        result = await db.query(`
          SELECT track_key, track, media
          FROM track_cache
          WHERE track_key LIKE $1
          ORDER BY
            CASE WHEN COALESCE(track->>'source','') = $2 THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `, [prefix, String(track?.source || '')]);
      }
    }

    if (!result.rowCount) return null;
    const row = result.rows[0];
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
