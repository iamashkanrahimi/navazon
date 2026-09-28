import { db } from './db.js';
import { applyPolicyDefaults } from './policy.js';

function normalize(value = '') {
  return String(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableVariant(track = {}) {
  let value = String(track.rawText || track.cmd || track.duration || track.bitrate || '');
  if (track.rawText) {
    value = value.replace(/\s+x\s+\d+(?:\.\d+)?\s*[kKmMgG]?\s*$/u, '').trim();
  }
  return normalize(value);
}

export function trackCacheKey(track = {}) {
  const artist = normalize(track.artist || '');
  const title = normalize(track.title || '');
  return `${artist}|${title}|${stableVariant(track)}`;
}

export class FileCache {
  async load() {}

  async get(track) {
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
        result = await db.query(
          'SELECT track_key, track, media FROM track_cache WHERE track_key LIKE $1 ORDER BY updated_at DESC LIMIT 1',
          [prefix]
        );
      }
    }

    if (!result.rowCount) return null;
    return {
      ...result.rows[0].media,
      ...result.rows[0].track,
      _cacheKey: result.rows[0].track_key,
    };
  }

  async set(track, media, { sourceFetch = true } = {}) {
    const policy = applyPolicyDefaults(track);
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
    await db.query(
      'UPDATE track_cache SET source_fetch_count = source_fetch_count + 1, updated_at = NOW() WHERE track_key = $1',
      [trackCacheKey(track)]
    );
  }

  async recordServe(track, { cacheHit = false, cacheKey = null } = {}) {
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
