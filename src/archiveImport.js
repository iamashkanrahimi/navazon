import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';

function assertImportConfig() {
  if (!config.archiveDatabaseUrl) throw new Error('ARCHIVE_DATABASE_URL missing');
  if (!config.archiveImportBaseUrl) throw new Error('ARCHIVE_IMPORT_BASE_URL missing');
}

function withVersion(url, token) {
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(String(token || Date.now()))}`;
}

async function fetchJson(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
    }
  }
  throw lastError;
}

async function fetchVerifiedGzip(url, expectedHash, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
        throw new Error(`GET ${url}: response is not gzip data`);
      }
      const actualHash = createHash('sha256').update(buffer).digest('hex');
      if (expectedHash && actualHash !== expectedHash) {
        throw new Error(
          `GET ${url}: SHA256 mismatch expected=${expectedHash} actual=${actualHash} bytes=${buffer.length}`
        );
      }
      console.log(`[archive import] verified download ${url.split('/').pop()} bytes=${buffer.length}`);
      return buffer;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_500 * attempt));
    }
  }
  throw lastError;
}

async function* readGzipJsonl(url, expectedHash) {
  const requestUrl = withVersion(url, expectedHash || Date.now());
  let compressed = await fetchVerifiedGzip(requestUrl, expectedHash);
  const payload = gunzipSync(compressed);
  compressed = null;

  let start = 0;
  let lineNumber = 0;
  for (let i = 0; i <= payload.length; i += 1) {
    if (i !== payload.length && payload[i] !== 0x0a) continue;
    let end = i;
    if (end > start && payload[end - 1] === 0x0d) end -= 1;
    if (end > start) {
      lineNumber += 1;
      const line = payload.subarray(start, end).toString('utf8');
      try {
        yield JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL ${url} line=${lineNumber}: ${err?.message || err}`);
      }
    }
    start = i + 1;
  }
}

async function forBatches(iterable, maxRows, fn) {
  let batch = [];
  let approxBytes = 0;
  for await (const row of iterable) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (batch.length && (batch.length >= maxRows || approxBytes + size > 900_000)) {
      await fn(batch);
      batch = [];
      approxBytes = 0;
    }
    batch.push(row);
    approxBytes += size;
  }
  if (batch.length) await fn(batch);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function importTracks(db, base, expectedHash) {
  let count = 0;
  await forBatches(readGzipJsonl(`${base}/rj-tracks.jsonl.gz`, expectedHash), 120, async rows => {
    await db.query(`
      INSERT INTO rj_tracks (
        source_url, source_id, source_slug, source_share_url, source_permalink,
        canonical_match_key, artist_display, artist_farsi, artist_names, artist_tags,
        title, title_farsi, album_title, album_farsi, album_artist,
        album_source_id, album_source_url, album_track_count, album_track_refs,
        release_date, release_date_raw, release_date_source, release_year, source_created_at,
        duration_seconds, lyrics_text, lyrics_available, lyrics_status, lyrics_synced,
        lyrics_integrity, credits, credits_list, credit_tags, explicit, cover_url,
        response_hash, fetch_attempts, diagnostics, schema_version, fetched_at
      )
      SELECT
        x.source_url, x.source_id, x.source_slug, x.source_share_url, x.source_permalink,
        x.canonical_match_key, x.artist_display, x.artist_farsi, x.artist_names, x.artist_tags,
        x.title, x.title_farsi, x.album_title, x.album_farsi, x.album_artist,
        x.album_source_id, x.album_source_url, x.album_track_count, x.album_track_refs,
        x.release_date, x.release_date_raw, x.release_date_source, x.release_year, x.source_created_at,
        x.duration_seconds, x.lyrics_text, x.lyrics_available, x.lyrics_status, x.lyrics_synced,
        x.lyrics_integrity, x.credits, x.credits_list, x.credit_tags, x.explicit, x.cover_url,
        x.response_hash, x.fetch_attempts, x.diagnostics, x.schema_version, now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        source_url text, source_id text, source_slug text, source_share_url text, source_permalink text,
        canonical_match_key text, artist_display text, artist_farsi text, artist_names jsonb, artist_tags jsonb,
        title text, title_farsi text, album_title text, album_farsi text, album_artist text,
        album_source_id text, album_source_url text, album_track_count integer, album_track_refs jsonb,
        release_date date, release_date_raw text, release_date_source text, release_year integer, source_created_at text,
        duration_seconds numeric, lyrics_text text, lyrics_available boolean, lyrics_status text, lyrics_synced jsonb,
        lyrics_integrity jsonb, credits text, credits_list jsonb, credit_tags jsonb, explicit boolean, cover_url text,
        response_hash text, fetch_attempts integer, diagnostics jsonb, schema_version integer
      )
      ON CONFLICT (source_url) DO UPDATE SET
        source_id=EXCLUDED.source_id, source_slug=EXCLUDED.source_slug,
        source_share_url=EXCLUDED.source_share_url, source_permalink=EXCLUDED.source_permalink,
        canonical_match_key=EXCLUDED.canonical_match_key, artist_display=EXCLUDED.artist_display,
        artist_farsi=EXCLUDED.artist_farsi, artist_names=EXCLUDED.artist_names, artist_tags=EXCLUDED.artist_tags,
        title=EXCLUDED.title, title_farsi=EXCLUDED.title_farsi,
        album_title=EXCLUDED.album_title, album_farsi=EXCLUDED.album_farsi, album_artist=EXCLUDED.album_artist,
        album_source_id=EXCLUDED.album_source_id, album_source_url=EXCLUDED.album_source_url,
        album_track_count=EXCLUDED.album_track_count, album_track_refs=EXCLUDED.album_track_refs,
        release_date=EXCLUDED.release_date, release_date_raw=EXCLUDED.release_date_raw,
        release_date_source=EXCLUDED.release_date_source, release_year=EXCLUDED.release_year,
        source_created_at=EXCLUDED.source_created_at, duration_seconds=EXCLUDED.duration_seconds,
        lyrics_text=EXCLUDED.lyrics_text, lyrics_available=EXCLUDED.lyrics_available,
        lyrics_status=EXCLUDED.lyrics_status, lyrics_synced=EXCLUDED.lyrics_synced,
        lyrics_integrity=EXCLUDED.lyrics_integrity, credits=EXCLUDED.credits,
        credits_list=EXCLUDED.credits_list, credit_tags=EXCLUDED.credit_tags,
        explicit=EXCLUDED.explicit, cover_url=EXCLUDED.cover_url, response_hash=EXCLUDED.response_hash,
        fetch_attempts=EXCLUDED.fetch_attempts, diagnostics=EXCLUDED.diagnostics,
        schema_version=EXCLUDED.schema_version, fetched_at=now()
    `, [JSON.stringify(rows)]);
    count += rows.length;
    if (count % 2000 < rows.length) console.log(`[archive import] tracks ${count}`);
  });
  return count;
}

async function importArtists(db, base, expectedHash) {
  let count = 0;
  await forBatches(readGzipJsonl(`${base}/rj-artists.jsonl.gz`, expectedHash), 250, async sourceRows => {
    const rows = sourceRows.map(a => ({
      artist_key: a.canonical_url,
      display_name: a.display_name || a.candidate_name || a.key,
      farsi_name: Array.isArray(a.farsi_names) ? (a.farsi_names[0] || null) : null,
      source_id: a.source_id == null ? null : String(a.source_id),
      source_url: a.canonical_url,
      image_url: a.image_url || null,
      image_kind: a.image_kind || null,
      image_source: a.image_source || null,
      quality_flags: a.quality_flags || [],
      metadata: a,
    }));
    await db.query(`
      INSERT INTO rj_artists (
        artist_key, display_name, farsi_name, source_id, source_url,
        image_url, image_kind, image_source, quality_flags, metadata, updated_at
      )
      SELECT x.artist_key, x.display_name, x.farsi_name, x.source_id, x.source_url,
             x.image_url, x.image_kind, x.image_source, x.quality_flags, x.metadata, now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        artist_key text, display_name text, farsi_name text, source_id text, source_url text,
        image_url text, image_kind text, image_source text, quality_flags jsonb, metadata jsonb
      )
      ON CONFLICT (artist_key) DO UPDATE SET
        display_name=EXCLUDED.display_name, farsi_name=EXCLUDED.farsi_name,
        source_id=EXCLUDED.source_id, source_url=EXCLUDED.source_url,
        image_url=EXCLUDED.image_url, image_kind=EXCLUDED.image_kind,
        image_source=EXCLUDED.image_source, quality_flags=EXCLUDED.quality_flags,
        metadata=EXCLUDED.metadata, updated_at=now()
    `, [JSON.stringify(rows)]);
    count += rows.length;
  });
  return count;
}

async function importAlbums(db, base, expectedHash) {
  let count = 0;
  await forBatches(readGzipJsonl(`${base}/rj-albums.jsonl.gz`, expectedHash), 200, async sourceRows => {
    const rows = sourceRows.map(a => ({
      album_key: a.canonical_url,
      source_id: a.api_source_id || null,
      source_url: a.canonical_url,
      artist_display: a.artist_display || a.candidate_artist || null,
      title: a.title || a.candidate_title || null,
      title_farsi: a.title_farsi || null,
      release_date: parseDate(a.release_date_raw || a.release_date_text),
      track_count: a.track_count ?? null,
      duration_seconds: a.duration_seconds ?? null,
      cover_url: a.cover_url || null,
      metadata: a,
    }));
    await db.query(`
      INSERT INTO rj_albums (
        album_key, source_id, source_url, artist_display, title, title_farsi,
        release_date, track_count, duration_seconds, cover_url, metadata, updated_at
      )
      SELECT x.album_key, x.source_id, x.source_url, x.artist_display, x.title, x.title_farsi,
             x.release_date, x.track_count, x.duration_seconds, x.cover_url, x.metadata, now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        album_key text, source_id text, source_url text, artist_display text, title text, title_farsi text,
        release_date date, track_count integer, duration_seconds numeric, cover_url text, metadata jsonb
      )
      ON CONFLICT (album_key) DO UPDATE SET
        source_id=EXCLUDED.source_id, source_url=EXCLUDED.source_url,
        artist_display=EXCLUDED.artist_display, title=EXCLUDED.title, title_farsi=EXCLUDED.title_farsi,
        release_date=EXCLUDED.release_date, track_count=EXCLUDED.track_count,
        duration_seconds=EXCLUDED.duration_seconds, cover_url=EXCLUDED.cover_url,
        metadata=EXCLUDED.metadata, updated_at=now()
    `, [JSON.stringify(rows)]);
    count += rows.length;
  });
  return count;
}

async function importAlbumTracks(db, base, expectedHash) {
  let count = 0;
  await forBatches(readGzipJsonl(`${base}/rj-album-tracks.jsonl.gz`, expectedHash), 500, async sourceRows => {
    const rows = sourceRows.map(t => ({
      album_key: t.album_key,
      source_url: t.permlink ? `https://www.radiojavan.com/mp3s/mp3/${t.permlink}` : null,
      source_id: t.source_id || null,
      position: t.position,
      artist_display: t.artist || null,
      title: t.title || null,
    }));
    await db.query(`
      INSERT INTO rj_album_tracks (album_key, source_url, source_id, position, artist_display, title)
      SELECT x.album_key, x.source_url, x.source_id, x.position, x.artist_display, x.title
      FROM jsonb_to_recordset($1::jsonb) AS x(
        album_key text, source_url text, source_id text, position integer, artist_display text, title text
      )
      ON CONFLICT (album_key, position) DO UPDATE SET
        source_url=EXCLUDED.source_url, source_id=EXCLUDED.source_id,
        artist_display=EXCLUDED.artist_display, title=EXCLUDED.title
    `, [JSON.stringify(rows)]);
    count += rows.length;
  });
  return count;
}

async function importMedia(db, base, expectedHash) {
  let count = 0;
  await forBatches(readGzipJsonl(`${base}/media-images.jsonl.gz`, expectedHash), 500, async rows => {
    await db.query(`
      INSERT INTO media_images (source_url, usage_types, sample_refs, status, updated_at)
      SELECT x.source_url, x.usage_types, x.sample_refs, 'pending', now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        source_url text, usage_types jsonb, sample_refs jsonb
      )
      ON CONFLICT (source_url) DO UPDATE SET
        usage_types=EXCLUDED.usage_types,
        sample_refs=EXCLUDED.sample_refs,
        updated_at=now()
    `, [JSON.stringify(rows)]);
    count += rows.length;
  });
  return count;
}

async function importArchiveOnce() {
  assertImportConfig();
  const db = getArchiveDb();
  const base = config.archiveImportBaseUrl;
  const manifest = await fetchJson(withVersion(`${base}/manifest.json`, Date.now()));

  const prior = await db.query(`SELECT value FROM archive_meta WHERE key='v5_import_complete'`);
  const priorHashes = prior.rows[0]?.value?.manifest?.hashes || prior.rows[0]?.value?.hashes || {};
  const manifestHashes = manifest.hashes || {};
  const hashEntries = Object.entries(manifestHashes);
  if (hashEntries.length && hashEntries.every(([name, hash]) => priorHashes[name] === hash)) {
    console.log('[archive import] V5 already imported; skipping');
    return { skipped: true, reason: 'already_imported' };
  }

  await db.query(`
    INSERT INTO archive_meta(key,value,updated_at)
    VALUES('v5_import_in_progress',$1::jsonb,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
  `, [JSON.stringify({ manifest, started_at: new Date().toISOString() })]);

  console.log('[archive import] starting V5');
  const counts = {};
  counts.tracks = await importTracks(db, base, manifestHashes['rj-tracks.jsonl.gz']);
  counts.artists = await importArtists(db, base, manifestHashes['rj-artists.jsonl.gz']);
  counts.albums = await importAlbums(db, base, manifestHashes['rj-albums.jsonl.gz']);
  counts.album_tracks = await importAlbumTracks(db, base, manifestHashes['rj-album-tracks.jsonl.gz']);
  counts.media_images = await importMedia(db, base, manifestHashes['media-images.jsonl.gz']);

  const qa = await db.query(`
    SELECT
      (SELECT count(*)::int FROM rj_tracks) tracks,
      (SELECT count(*)::int FROM rj_artists) artists,
      (SELECT count(*)::int FROM rj_albums) albums,
      (SELECT count(*)::int FROM rj_album_tracks) album_tracks,
      (SELECT count(*)::int FROM media_images) media_images
  `);

  const value = {
    manifest,
    imported_rows: counts,
    database_counts: qa.rows[0],
    completed_at: new Date().toISOString(),
  };
  await db.query(`
    INSERT INTO archive_meta(key,value,updated_at)
    VALUES('v5_import_complete',$1::jsonb,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
  `, [JSON.stringify(value)]);
  console.log('[archive import] complete', JSON.stringify(value.database_counts));
  return value;
}

export async function runArchiveImportIfEnabled() {
  if (!config.archiveImportOnce) return { skipped: true, reason: 'disabled' };

  let attempt = 0;
  while (config.archiveImportOnce) {
    attempt += 1;
    try {
      return await importArchiveOnce();
    } catch (err) {
      const delayMs = 5 * 60 * 1000;
      console.warn(
        `[archive import] attempt=${attempt} failed: ${err?.message || err}; retrying in 5m`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { skipped: true, reason: 'disabled' };
}
