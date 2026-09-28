import { db } from './db.js';
import { applyPolicyDefaults } from './policy.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalize(value = '') {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackIdentity(track = {}) {
  return [normalize(track.artist), normalize(track.title), normalize(track.rawText || track.cmd || '')].join('|');
}

function freshEnough(iso, maxAgeMs) {
  if (!iso || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t <= maxAgeMs;
}

function featuredArtistsFromTitle(title = '') {
  const out = [];
  const text = clean(title);
  const patterns = [/\b(?:feat\.?|ft\.?|featuring)\s+([^()\[\]–—-]+)/igu];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const chunk = clean(match[1]);
      for (const name of chunk.split(/\s*(?:&|,|\bx\b)\s*/iu)) {
        const value = clean(name);
        if (value && value.length <= 80) out.push(value);
      }
    }
  }
  return [...new Set(out)];
}

export class CatalogStore {
  async load() {}

  compactTrack(track = {}) {
    const policy = applyPolicyDefaults(track);
    return {
      artist: clean(policy.artist),
      title: clean(policy.title),
      rawText: clean(policy.rawText),
      cmd: clean(policy.cmd),
      source: policy.source || undefined,
      duration: policy.duration || undefined,
      bitrate: policy.bitrate || undefined,
      sourcePopularityText: policy.sourcePopularityText || undefined,
      sourcePopularityCount: Number.isFinite(policy.sourcePopularityCount) ? policy.sourcePopularityCount : undefined,
      discoveredAt: policy.discoveredAt || new Date().toISOString(),
      contentOrigin: policy.contentOrigin,
      availabilityPolicy: policy.availabilityPolicy,
      restrictionSource: policy.restrictionSource,
      restrictionReason: policy.restrictionReason,
      availabilityUpdatedAt: policy.availabilityUpdatedAt,
    };
  }

  async readArtist(name) {
    const key = normalize(name);
    if (!key) return { key: '', node: null };
    const result = await db.query('SELECT name, data FROM artists WHERE artist_key = $1', [key]);
    if (!result.rowCount) {
      return {
        key,
        node: {
          name: clean(name),
          tracks: {},
          albums: {},
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return { key, node: { ...result.rows[0].data, name: result.rows[0].name || clean(name) } };
  }

  async writeArtist(key, node) {
    if (!key || !node) return;
    await db.query(`
      INSERT INTO artists (artist_key, name, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (artist_key) DO UPDATE SET
        name = EXCLUDED.name,
        data = EXCLUDED.data,
        updated_at = NOW()
    `, [key, clean(node.name), JSON.stringify(node)]);
  }

  addTracksToNode(node, tracks = []) {
    node.tracks ||= {};
    for (const track of tracks) {
      const id = trackIdentity(track);
      if (!id || id === '||') continue;
      node.tracks[id] = this.compactTrack(track);
    }
    node.updatedAt = new Date().toISOString();
  }

  async seedArtistsFromTracks(tracks = [], discoveredFrom = 'tracks') {
    const names = new Map();
    for (const track of tracks) {
      if (track?.artist) {
        const key = normalize(track.artist);
        if (key) names.set(key, { name: track.artist, seedTracks: [track], discoveredFrom });
      }
      for (const name of featuredArtistsFromTitle(track?.title || '')) {
        const key = normalize(name);
        if (!key) continue;
        const current = names.get(key) || { name, seedTracks: [], discoveredFrom: `${discoveredFrom}:feature` };
        names.set(key, current);
      }
    }

    await Promise.all([...names.values()].map(async ({ name, seedTracks, discoveredFrom: source }) => {
      const { key, node } = await this.readArtist(name);
      if (!node.discoveredFrom) node.discoveredFrom = source;
      if (seedTracks.length) this.addTracksToNode(node, seedTracks);
      await this.writeArtist(key, node);
    }));
  }

  async ensureArtist(name, { seedTrack = null, discoveredFrom = null } = {}) {
    const { key, node } = await this.readArtist(name);
    if (!key || !node) return null;
    if (discoveredFrom && !node.discoveredFrom) node.discoveredFrom = clean(discoveredFrom);
    if (seedTrack) this.addTracksToNode(node, [seedTrack]);
    await this.writeArtist(key, node);
    return node;
  }

  async getArtistContext(name, maxAgeMs) {
    const { node } = await this.readArtist(name);
    if (!node || !freshEnough(node.artistUpdatedAt, maxAgeMs)) return null;
    const topTracks = Array.isArray(node.topTracks) ? node.topTracks : [];
    const recentTracks = Array.isArray(node.recentTracks) ? node.recentTracks : [];
    if (!topTracks.length && !recentTracks.length) return null;
    return {
      artist: node.name || clean(name),
      tracks: topTracks.length ? topTracks : recentTracks,
      topTracks,
      recentTracks,
      albumButton: node.albumButton || null,
      albumsAvailable: Array.isArray(node.albumList) && node.albumList.length > 0,
      fromCatalog: true,
    };
  }

  async getAlbums(name, maxAgeMs, emptyMaxAgeMs = maxAgeMs) {
    const { node } = await this.readArtist(name);
    if (!node || !Array.isArray(node.albumList)) return null;

    const ttl = node.albumList.length ? maxAgeMs : emptyMaxAgeMs;
    if (!freshEnough(node.albumsUpdatedAt, ttl)) return null;
    return node.albumList;
  }

  async searchAlbums(query, limit = 4) {
    const tokens = normalize(query)
      .split(' ')
      .filter(token => token.length >= 2 && !['album','آلبوم'].includes(token));
    if (!tokens.length) return [];

    const clauses = tokens.map((_, index) =>
      `LOWER(a.name || ' ' || COALESCE(album->>'title','')) LIKE ${index + 1}`
    );
    const params = tokens.map(token => `%${token}%`);
    params.push(Math.max(1, Number(limit || 4)));

    const result = await db.query(`
      SELECT
        a.name AS artist,
        album->>'title' AS title,
        NULLIF(album->>'trackCount','')::int AS track_count,
        album->>'rawText' AS raw_text
      FROM artists a
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(a.data->'albumList','[]'::jsonb)
      ) album
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.updated_at DESC
      LIMIT ${params.length}
    `, params);

    return result.rows
      .filter(row => row.artist && row.title)
      .map(row => ({
        artist: row.artist,
        title: row.title,
        trackCount: row.track_count || undefined,
        rawText: row.raw_text || undefined,
        source: 'catalog',
      }));
  }

  async getAlbumTracks(name, albumTitle, maxAgeMs) {
    const { node } = await this.readArtist(name);
    const album = node?.albums?.[normalize(albumTitle)];
    if (!album || !freshEnough(album.updatedAt, maxAgeMs)) return null;
    return Array.isArray(album.tracks) && album.tracks.length ? album.tracks : null;
  }

  async getSearch(query, maxAgeMs) {
    const key = normalize(query);
    if (!key || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null;
    const result = await db.query(`
      SELECT tracks, updated_at
      FROM searches
      WHERE query_key = $1
        AND updated_at >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
      LIMIT 1
    `, [key, Math.max(0, maxAgeMs)]);
    if (!result.rowCount) return null;
    const tracks = result.rows[0].tracks;
    return Array.isArray(tracks) && tracks.length ? tracks : null;
  }

  async recordSearch(query, tracks = []) {
    const compact = tracks.map(track => this.compactTrack(track));
    await db.query(`
      INSERT INTO searches (query_key, query, tracks)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (query_key) DO UPDATE SET
        query = EXCLUDED.query,
        tracks = EXCLUDED.tracks,
        updated_at = NOW()
    `, [normalize(query), clean(query), JSON.stringify(compact)]);
    await this.seedArtistsFromTracks(tracks, 'search');
  }

  async recordArtist(name, { topTracks = [], recentTracks = [], albumButton = null } = {}) {
    const { key, node } = await this.readArtist(name);
    if (!node) return;
    node.topTracks = topTracks.map(track => this.compactTrack(track));
    node.recentTracks = recentTracks.map(track => this.compactTrack(track));
    node.albumButton = clean(albumButton || node.albumButton || '') || null;
    node.artistUpdatedAt = new Date().toISOString();
    this.addTracksToNode(node, [...topTracks, ...recentTracks]);
    await this.writeArtist(key, node);
    await this.seedArtistsFromTracks([...topTracks, ...recentTracks], `artist:${clean(name)}`);
  }

  async recordAlbums(name, albums = []) {
    const { key, node } = await this.readArtist(name);
    if (!node) return;
    node.albumList = albums.map(album => ({
      title: clean(album.title),
      trackCount: album.trackCount || undefined,
      rawText: clean(album.rawText),
    }));
    node.albumsUpdatedAt = new Date().toISOString();
    node.albums ||= {};
    for (const album of albums) {
      const albumKey = normalize(album.title);
      if (!albumKey) continue;
      node.albums[albumKey] = {
        ...(node.albums[albumKey] || {}),
        title: clean(album.title),
        trackCount: album.trackCount || undefined,
        rawText: clean(album.rawText),
        listingUpdatedAt: new Date().toISOString(),
      };
    }
    await this.writeArtist(key, node);
  }

  async recordAlbumTracks(name, album, tracks = []) {
    const { key, node } = await this.readArtist(name);
    if (!node) return;
    const albumKey = normalize(album.title);
    node.albums ||= {};
    node.albums[albumKey] ||= { title: clean(album.title) };
    node.albums[albumKey].tracks = tracks.map(track => this.compactTrack(track));
    node.albums[albumKey].updatedAt = new Date().toISOString();
    this.addTracksToNode(node, tracks);
    await this.writeArtist(key, node);
    await this.seedArtistsFromTracks(tracks, `album:${clean(album.title)}`);
  }

  async recordSupplementalTracks(name, tracks = [], source = 'supplemental') {
    const { key, node } = await this.readArtist(name);
    if (!node) return;
    this.addTracksToNode(node, tracks);
    await this.writeArtist(key, node);
    await this.seedArtistsFromTracks(tracks, source);
  }

  async nextDiscoveryCandidate(minAgeMs) {
    const result = await db.query(`
      SELECT name, data
      FROM artists
      ORDER BY
        CASE WHEN data->>'discoveryNextAt' IS NULL AND data->>'discoveryCheckedAt' IS NULL THEN 0 ELSE 1 END,
        COALESCE((data->>'discoveryNextAt')::timestamptz, (data->>'discoveryCheckedAt')::timestamptz, to_timestamp(0)) ASC
      LIMIT 250
    `);
    const now = Date.now();
    for (const row of result.rows) {
      const node = { ...row.data, name: row.name };
      const nextAt = Date.parse(node.discoveryNextAt || '') || 0;
      if (nextAt && nextAt > now) continue;
      const checkedAt = Date.parse(node.discoveryCheckedAt || '') || 0;
      if (!nextAt && checkedAt && now - checkedAt < minAgeMs) continue;
      const tracks = Object.values(node.tracks || {});
      const seedTrack = tracks.find(track => track?.source === 'melobot' && track?.rawText) || null;
      return { artist: node.name, seedTrack, checkedAt, nextAt };
    }
    return null;
  }

  async markDiscoveryChecked(name, { ok = true, error = null, nextDelayMs = null } = {}) {
    const { key, node } = await this.readArtist(name);
    if (!node) return;
    const now = Date.now();
    node.discoveryCheckedAt = new Date(now).toISOString();
    node.discoveryLastOk = Boolean(ok);
    node.discoveryLastError = error ? clean(error).slice(0, 300) : null;
    node.discoveryNextAt = Number.isFinite(nextDelayMs) && nextDelayMs > 0
      ? new Date(now + nextDelayMs).toISOString()
      : null;
    await this.writeArtist(key, node);
  }

  async staleAlbumCount(name, albums = [], maxAgeMs) {
    const { node } = await this.readArtist(name);
    let count = 0;
    for (const album of albums) {
      const saved = node?.albums?.[normalize(album.title)];
      if (!saved || !freshEnough(saved.updatedAt, maxAgeMs)) count += 1;
    }
    return count;
  }

  async firstStaleAlbum(name, albums = [], maxAgeMs) {
    const { node } = await this.readArtist(name);
    for (const album of albums) {
      const saved = node?.albums?.[normalize(album.title)];
      if (!saved || !freshEnough(saved.updatedAt, maxAgeMs)) return album;
    }
    return null;
  }
}
