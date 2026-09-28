import { db } from './db.js';
import { applyPolicyDefaults } from './policy.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function deepNormalize(value = '') {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deepTrackKey(track = {}) {
  return `${deepNormalize(track.artist)}|${deepNormalize(track.title)}`;
}

export function deepAlbumKey(artist = '', title = '') {
  return `${deepNormalize(artist)}|${deepNormalize(title)}`;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

export class DeepCatalog {
  async upsertTrack(track = {}, extra = {}) {
    const policy = applyPolicyDefaults({ ...track, ...extra });
    const trackKey = deepTrackKey(policy);
    if (!trackKey || trackKey === '|') return null;

    const sourceData = {
      rawText: policy.rawText || undefined,
      cmd: policy.cmd || undefined,
      source: policy.source || undefined,
      sourcePopularityText: policy.sourcePopularityText || undefined,
      sourcePopularityCount: Number.isFinite(policy.sourcePopularityCount)
        ? policy.sourcePopularityCount
        : undefined,
      discoveredFrom: extra.discoveredFrom || undefined,
      feed: extra.feed || undefined,
    };

    await db.query(`
      INSERT INTO deep_tracks (
        track_key, artist, title, album, duration_seconds,
        popularity_count, popularity_text,
        content_origin, availability_policy,
        source_data, metadata, discovered_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,NOW(),NOW()
      )
      ON CONFLICT (track_key) DO UPDATE SET
        artist = EXCLUDED.artist,
        title = EXCLUDED.title,
        album = COALESCE(EXCLUDED.album, deep_tracks.album),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, deep_tracks.duration_seconds),
        popularity_count = COALESCE(EXCLUDED.popularity_count, deep_tracks.popularity_count),
        popularity_text = COALESCE(EXCLUDED.popularity_text, deep_tracks.popularity_text),
        content_origin = CASE
          WHEN EXCLUDED.content_origin <> 'unknown' THEN EXCLUDED.content_origin
          ELSE deep_tracks.content_origin
        END,
        availability_policy = CASE
          WHEN EXCLUDED.availability_policy <> 'unknown' THEN EXCLUDED.availability_policy
          ELSE deep_tracks.availability_policy
        END,
        source_data = deep_tracks.source_data || EXCLUDED.source_data,
        metadata = deep_tracks.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      trackKey,
      clean(policy.artist),
      clean(policy.title),
      clean(extra.album || policy.album || '') || null,
      Number(policy.durationSeconds || policy.duration || 0) || null,
      Number.isFinite(policy.sourcePopularityCount) ? policy.sourcePopularityCount : null,
      policy.sourcePopularityText || null,
      policy.contentOrigin || 'unknown',
      policy.availabilityPolicy || 'unknown',
      safeJson(sourceData),
      safeJson(extra.metadata || {}),
    ]);

    return trackKey;
  }

  async setArtistList(artist, listType, tracks = []) {
    const artistKey = deepNormalize(artist);
    if (!artistKey) return;
    await db.query('DELETE FROM deep_artist_tracks WHERE artist_key = $1 AND list_type = $2', [artistKey, listType]);
    let rank = 0;
    for (const track of tracks) {
      rank += 1;
      const trackKey = await this.upsertTrack(track, { discoveredFrom: `artist:${listType}` });
      if (!trackKey) continue;
      await db.query(`
        INSERT INTO deep_artist_tracks (artist_key, artist_name, list_type, track_key, rank, observed_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (artist_key, list_type, track_key) DO UPDATE SET
          rank = EXCLUDED.rank,
          observed_at = NOW()
      `, [artistKey, clean(artist), listType, trackKey, rank]);
    }
  }

  async upsertAlbum(artist, album = {}) {
    const albumKey = deepAlbumKey(artist, album.title);
    if (!albumKey || albumKey === '|') return null;
    await db.query(`
      INSERT INTO deep_albums (album_key, artist, title, track_count, metadata, updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
      ON CONFLICT (album_key) DO UPDATE SET
        track_count = COALESCE(EXCLUDED.track_count, deep_albums.track_count),
        metadata = deep_albums.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      albumKey,
      clean(artist),
      clean(album.title),
      Number(album.trackCount || 0) || null,
      safeJson({ rawText: album.rawText || undefined }),
    ]);
    return albumKey;
  }

  async setAlbumTracks(artist, album, tracks = []) {
    const albumKey = await this.upsertAlbum(artist, album);
    if (!albumKey) return;
    await db.query('DELETE FROM deep_album_tracks WHERE album_key = $1', [albumKey]);
    let position = 0;
    for (const track of tracks) {
      position += 1;
      const trackKey = await this.upsertTrack(track, {
        album: album.title,
        discoveredFrom: 'album',
      });
      if (!trackKey) continue;
      await db.query(`
        INSERT INTO deep_album_tracks (album_key, track_key, position)
        VALUES ($1,$2,$3)
        ON CONFLICT (album_key, track_key) DO UPDATE SET position = EXCLUDED.position
      `, [albumKey, trackKey, position]);
    }
  }

  async setMedia(track, quality, media = {}, extra = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey || !media.fileId) return;
    await db.query(`
      INSERT INTO deep_track_media (
        track_key, quality, file_id, file_unique_id, kind,
        bitrate, file_size, duration_seconds, source, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (track_key, quality) DO UPDATE SET
        file_id = EXCLUDED.file_id,
        file_unique_id = COALESCE(EXCLUDED.file_unique_id, deep_track_media.file_unique_id),
        kind = EXCLUDED.kind,
        bitrate = COALESCE(EXCLUDED.bitrate, deep_track_media.bitrate),
        file_size = COALESCE(EXCLUDED.file_size, deep_track_media.file_size),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, deep_track_media.duration_seconds),
        source = EXCLUDED.source,
        updated_at = NOW()
    `, [
      trackKey,
      quality,
      media.fileId,
      media.fileUniqueId || null,
      media.kind || 'audio',
      Number(extra.bitrate || 0) || null,
      Number(extra.fileSize || media.fileSize || 0) || null,
      Number(media.duration || extra.duration || 0) || null,
      extra.source || track.source || 'melobot',
    ]);
  }

  async setCover(track, media = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey || !media.fileId) return;
    await db.query(`
      UPDATE deep_tracks
      SET cover_file_id = $2,
          cover_unique_id = $3,
          cover_meta = cover_meta || $4::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [
      trackKey,
      media.fileId,
      media.fileUniqueId || null,
      safeJson({
        width: media.width || undefined,
        height: media.height || undefined,
        fileSize: media.fileSize || undefined,
      }),
    ]);
  }

  async setLyrics(track, lyricsText, source = 'melobot') {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    await db.query(`
      UPDATE deep_tracks
      SET lyrics_text = $2,
          lyrics_source = $3,
          lyrics_updated_at = NOW(),
          metadata = metadata || '{"hasLyrics":true}'::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [trackKey, String(lyricsText || '').trim(), source]);
  }

  async markNoLyrics(track, source = 'melobot') {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    await db.query(`
      UPDATE deep_tracks
      SET lyrics_source = $2,
          lyrics_updated_at = NOW(),
          metadata = metadata || '{"hasLyrics":false}'::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [trackKey, source]);
  }

  async setMetadata(track, patch = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    const releaseDate = patch.releaseDate || null;
    const releaseDateRaw = patch.releaseDateRaw || null;
    const popularityCount = Number.isFinite(patch.popularityCount) ? patch.popularityCount : null;
    await db.query(`
      UPDATE deep_tracks
      SET release_date = COALESCE($2::date, release_date),
          release_date_raw = COALESCE($3, release_date_raw),
          popularity_count = COALESCE($4, popularity_count),
          popularity_text = COALESCE($5, popularity_text),
          metadata = metadata || $6::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [
      trackKey,
      releaseDate,
      releaseDateRaw,
      popularityCount,
      patch.popularityText || null,
      safeJson(patch.raw || patch),
    ]);
  }

  async enqueueTask(kind, payload = {}, {
    priority = 50,
    delayMs = 0,
    taskKey = null,
    reviveDone = false,
  } = {}) {
    const key = taskKey || `${kind}:${payload.trackKey || payload.artist || payload.feed || JSON.stringify(payload)}`;
    const availableAt = new Date(Date.now() + Math.max(0, delayMs));
    await db.query(`
      INSERT INTO crawl_tasks (task_key, kind, payload, priority, status, available_at)
      VALUES ($1,$2,$3::jsonb,$4,'queued',$5)
      ON CONFLICT (task_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        priority = GREATEST(crawl_tasks.priority, EXCLUDED.priority),
        available_at = LEAST(crawl_tasks.available_at, EXCLUDED.available_at),
        status = CASE
          WHEN crawl_tasks.status IN ('failed','queued') THEN 'queued'
          WHEN $6::boolean AND crawl_tasks.status = 'done' THEN 'queued'
          ELSE crawl_tasks.status
        END,
        updated_at = NOW()
    `, [key, kind, safeJson(payload), priority, availableAt, reviveDone]);
    return key;
  }

  async seedTrackTasks(track, { priority = 70 } = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    const payload = { track: { ...track, trackKey }, trackKey };
    await this.enqueueTask('track_hq', payload, { priority: priority + 20, taskKey: `track_hq:${trackKey}` });
    await this.enqueueTask('track_normal', payload, { priority: priority + 10, taskKey: `track_normal:${trackKey}` });
    await this.enqueueTask('track_metadata', payload, { priority: priority + 5, taskKey: `track_metadata:${trackKey}` });
    await this.enqueueTask('track_cover', payload, { priority, taskKey: `track_cover:${trackKey}` });
    await this.enqueueTask('track_lyrics', payload, { priority: priority - 5, taskKey: `track_lyrics:${trackKey}` });
  }

  async claimNextTask() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        SELECT id, task_key, kind, payload, priority, attempts
        FROM crawl_tasks
        WHERE status = 'queued' AND available_at <= NOW()
        ORDER BY priority DESC, available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const task = result.rows[0];
      await client.query(`
        UPDATE crawl_tasks
        SET status = 'running', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [task.id]);
      await client.query('COMMIT');
      return task;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finishTask(id, summary = {}) {
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'done', completed_at = NOW(), updated_at = NOW(),
          last_error = NULL, result = $2::jsonb
      WHERE id = $1
    `, [id, safeJson(summary)]);
  }

  async failTask(id, error, { retryDelayMs = 6 * 60 * 60 * 1000, maxAttempts = 4 } = {}) {
    const result = await db.query('SELECT attempts FROM crawl_tasks WHERE id = $1', [id]);
    const attempts = Number(result.rows[0]?.attempts || 0);
    const terminal = attempts >= maxAttempts;
    await db.query(`
      UPDATE crawl_tasks
      SET status = $2,
          available_at = CASE WHEN $2 = 'queued' THEN NOW() + ($3 * INTERVAL '1 millisecond') ELSE available_at END,
          last_error = $4,
          updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      terminal ? 'failed' : 'queued',
      Math.max(0, retryDelayMs),
      String(error || 'unknown error').slice(0, 1000),
    ]);
  }

  async enqueueFeedSweep() {
    const feeds = [
      { feed: '/new', priority: 120, everyMs: 30 * 60 * 1000, origin: 'iranian' },
      { feed: '/topday', priority: 118, everyMs: 60 * 60 * 1000, origin: 'unknown' },
      { feed: '/topweek', priority: 116, everyMs: 6 * 60 * 60 * 1000, origin: 'unknown' },
      { feed: '/foreign', priority: 114, everyMs: 2 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/turkish', priority: 112, everyMs: 6 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/arabic', priority: 110, everyMs: 6 * 60 * 60 * 1000, origin: 'foreign' },
    ];
    const now = Date.now();
    for (const item of feeds) {
      const bucket = Math.floor(now / item.everyMs);
      await this.enqueueTask('feed', item, {
        priority: item.priority,
        taskKey: `feed:${item.feed}:${bucket}`,
      });
    }
  }

  async stats() {
    const [tracks, media, tasks, albums, lists] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::bigint AS tracks,
          COUNT(*) FILTER (WHERE lyrics_text IS NOT NULL AND lyrics_text <> '')::bigint AS lyrics,
          COUNT(*) FILTER (WHERE cover_file_id IS NOT NULL)::bigint AS covers,
          COUNT(*) FILTER (WHERE release_date IS NOT NULL OR release_date_raw IS NOT NULL)::bigint AS release_dates
        FROM deep_tracks
      `),
      db.query(`
        SELECT
          COUNT(*)::bigint AS media,
          COUNT(*) FILTER (WHERE quality = 'hq')::bigint AS hq,
          COUNT(*) FILTER (WHERE quality = 'normal')::bigint AS normal
        FROM deep_track_media
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
          COUNT(*) FILTER (WHERE status = 'running')::bigint AS running,
          COUNT(*) FILTER (WHERE status = 'done')::bigint AS done,
          COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
        FROM crawl_tasks
      `),
      db.query('SELECT COUNT(*)::bigint AS albums FROM deep_albums'),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE list_type = 'recent')::bigint AS recent_rows,
          COUNT(*) FILTER (WHERE list_type = 'top')::bigint AS top_rows
        FROM deep_artist_tracks
      `),
    ]);
    const num = row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v]));
    return {
      tracks: num(tracks.rows[0]),
      media: num(media.rows[0]),
      tasks: num(tasks.rows[0]),
      albums: num(albums.rows[0]),
      artistLists: num(lists.rows[0]),
    };
  }
}
