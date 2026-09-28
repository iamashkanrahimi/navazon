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

    const rows = await Promise.all((tracks || []).map(async (track, index) => {
      const trackKey = await this.upsertTrack(track, { discoveredFrom: `artist:${listType}` });
      return trackKey ? { trackKey, rank: index + 1 } : null;
    }));

    await Promise.all(rows.filter(Boolean).map(row => db.query(`
      INSERT INTO deep_artist_tracks (artist_key, artist_name, list_type, track_key, rank, observed_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (artist_key, list_type, track_key) DO UPDATE SET
        rank = EXCLUDED.rank,
        observed_at = NOW()
    `, [artistKey, clean(artist), listType, row.trackKey, row.rank])));
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

    const rows = await Promise.all((tracks || []).map(async (track, index) => {
      const trackKey = await this.upsertTrack(track, {
        album: album.title,
        discoveredFrom: 'album',
      });
      return trackKey ? { trackKey, position: index + 1 } : null;
    }));

    await Promise.all(rows.filter(Boolean).map(row => db.query(`
      INSERT INTO deep_album_tracks (album_key, track_key, position)
      VALUES ($1,$2,$3)
      ON CONFLICT (album_key, track_key) DO UPDATE SET position = EXCLUDED.position
    `, [albumKey, row.trackKey, row.position])));
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
    await this.completeTaskByKey(`track_${quality}:${trackKey}`, {
      satisfiedBy: extra.satisfiedBy || 'media_cache',
      quality,
    });
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
    await this.completeTaskByKey(`track_cover:${trackKey}`, { satisfiedBy: 'track_enrich' });
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
    await this.completeTaskByKey(`track_lyrics:${trackKey}`, { satisfiedBy: 'track_enrich' });
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
    await this.completeTaskByKey(`track_lyrics:${trackKey}`, { satisfiedBy: 'track_enrich', available: false });
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
      safeJson({
        ...(patch.raw && typeof patch.raw === 'object' ? patch.raw : patch),
        ...(typeof patch.raw === 'string' && patch.raw ? { raw: patch.raw } : {}),
        metadataCheckedAt: new Date().toISOString(),
      }),
    ]);
    await this.completeTaskByKey(`track_metadata:${trackKey}`, { satisfiedBy: 'track_enrich' });
  }

  async getTrackDetails(track = {}) {
    const trackKey = deepTrackKey(track);
    if (!trackKey || trackKey === '|') return null;

    const [trackResult, mediaResult, albumResult] = await Promise.all([
      db.query(`
        SELECT track_key, artist, title, album, duration_seconds,
          release_date, release_date_raw, popularity_count, popularity_text,
          content_origin, availability_policy, metadata,
          lyrics_text, lyrics_source,
          cover_file_id, cover_unique_id, cover_meta
        FROM deep_tracks
        WHERE track_key = $1
      `, [trackKey]),
      db.query(`
        SELECT quality, file_id, file_unique_id, kind, bitrate, file_size, duration_seconds, source
        FROM deep_track_media
        WHERE track_key = $1
      `, [trackKey]),
      db.query(`
        SELECT a.album_key, a.artist, a.title, a.track_count
        FROM deep_album_tracks dat
        JOIN deep_albums a ON a.album_key = dat.album_key
        WHERE dat.track_key = $1
        ORDER BY a.updated_at DESC
        LIMIT 1
      `, [trackKey]),
    ]);

    const row = trackResult.rows[0] || null;
    const media = {};
    for (const item of mediaResult.rows) {
      media[item.quality] = {
        fileId: item.file_id,
        fileUniqueId: item.file_unique_id,
        kind: item.kind,
        bitrate: item.bitrate,
        fileSize: item.file_size ? Number(item.file_size) : undefined,
        duration: item.duration_seconds || undefined,
        source: item.source || undefined,
      };
    }

    return {
      ...(row || {
        track_key: trackKey,
        artist: clean(track.artist),
        title: clean(track.title),
      }),
      media,
      albumInfo: albumResult.rows[0] || null,
    };
  }

  async getArtistList(artist, listType = 'top', limit = 10) {
    const artistKey = deepNormalize(artist);
    if (!artistKey) return [];
    const result = await db.query(`
      SELECT
        t.track_key,
        t.artist,
        t.title,
        t.album,
        t.duration_seconds,
        t.popularity_count,
        t.popularity_text,
        t.content_origin,
        t.availability_policy,
        t.source_data,
        at.rank
      FROM deep_artist_tracks at
      JOIN deep_tracks t ON t.track_key = at.track_key
      WHERE at.artist_key = $1 AND at.list_type = $2
      ORDER BY at.rank ASC NULLS LAST, at.observed_at DESC
      LIMIT $3
    `, [artistKey, listType, Math.max(1, Number(limit || 10))]);

    return result.rows.map(row => ({
      artist: row.artist,
      title: row.title,
      album: row.album || undefined,
      durationSeconds: row.duration_seconds || undefined,
      sourcePopularityCount: row.popularity_count ? Number(row.popularity_count) : undefined,
      sourcePopularityText: row.popularity_text || undefined,
      contentOrigin: row.content_origin || 'unknown',
      availabilityPolicy: row.availability_policy || 'unknown',
      ...(row.source_data || {}),
      source: row.source_data?.source || 'melobot',
      rawText: row.source_data?.rawText || undefined,
    }));
  }

  async getAlbumTracksByKey(albumKey) {
    if (!albumKey) return [];
    const result = await db.query(`
      SELECT t.*, dat.position
      FROM deep_album_tracks dat
      JOIN deep_tracks t ON t.track_key = dat.track_key
      WHERE dat.album_key = $1
      ORDER BY dat.position ASC NULLS LAST
    `, [albumKey]);
    return result.rows.map(row => ({
      artist: row.artist,
      title: row.title,
      album: row.album || undefined,
      durationSeconds: row.duration_seconds || undefined,
      sourcePopularityCount: row.popularity_count ? Number(row.popularity_count) : undefined,
      sourcePopularityText: row.popularity_text || undefined,
      contentOrigin: row.content_origin || 'unknown',
      availabilityPolicy: row.availability_policy || 'unknown',
      ...(row.source_data || {}),
      source: row.source_data?.source || 'melobot',
      rawText: row.source_data?.rawText || undefined,
    }));
  }

  async completeTaskByKey(taskKey, summary = {}) {
    if (!taskKey) return;
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'done',
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW(),
          last_error = NULL,
          result = result || $2::jsonb
      WHERE task_key = $1 AND status <> 'running'
    `, [taskKey, safeJson(summary)]);
  }

  async missingMediaTracks(tracks = [], quality = 'hq') {
    const keyed = (tracks || [])
      .map(track => ({ track, key: deepTrackKey(track) }))
      .filter(item => item.key && item.key !== '|');
    if (!keyed.length) return [];

    const keys = keyed.map(item => item.key);
    const result = await db.query(`
      SELECT track_key
      FROM deep_track_media
      WHERE quality = $1 AND track_key = ANY($2::text[])
    `, [quality, keys]);
    const present = new Set(result.rows.map(row => row.track_key));
    return keyed.filter(item => !present.has(item.key)).map(item => item.track);
  }

  async compactQueue() {
    await db.query(`
      UPDATE crawl_tasks legacy
      SET status = 'done',
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW(),
          result = legacy.result || '{"supersededBy":"track_enrich"}'::jsonb
      WHERE legacy.status = 'queued'
        AND legacy.kind IN ('track_metadata','track_cover','track_lyrics')
        AND EXISTS (
          SELECT 1
          FROM crawl_tasks bundle
          WHERE bundle.task_key =
            'track_enrich:' || substring(legacy.task_key from position(':' in legacy.task_key) + 1)
            AND bundle.status IN ('queued','running','done')
        )
    `);

    -- Recurring bucketed tasks have new keys on future runs, so old completed
    -- rows can be removed without losing one-time completion memory.
    await db.query(`
      DELETE FROM crawl_tasks
      WHERE status = 'done'
        AND kind IN ('feed','home_discovery','artist_profile','artist_bulk_media')
        AND completed_at < NOW() - INTERVAL '21 days'
    `);
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
      WHERE crawl_tasks.status <> 'done' OR $6::boolean
    `, [key, kind, safeJson(payload), priority, availableAt, reviveDone]);
    return key;
  }

  async seedTrackTasks(track, { priority = 70, preferBulk = false, includeMedia = true } = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    const payload = { track: { ...track, trackKey }, trackKey };

    // One bundled enrichment task replaces three separate 2-minute crawler turns.
    await this.enqueueTask('track_enrich', payload, {
      priority: priority + 5,
      taskKey: `track_enrich:${trackKey}`,
    });

    if (includeMedia) {
      // Individual media tasks remain as a low-priority safety net. Native bulk
      // artist/album tasks will satisfy and auto-complete these when possible.
      const hqPriority = preferBulk ? priority - 18 : priority + 20;
      const normalPriority = preferBulk ? priority - 24 : priority + 10;
      await this.enqueueTask('track_hq', payload, {
        priority: hqPriority,
        taskKey: `track_hq:${trackKey}`,
      });
      await this.enqueueTask('track_normal', payload, {
        priority: normalPriority,
        taskKey: `track_normal:${trackKey}`,
      });
    }
  }

  async claimNextTask() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE crawl_tasks
        SET status = 'queued',
            available_at = NOW(),
            last_error = COALESCE(last_error, 'recovered stale running task'),
            updated_at = NOW()
        WHERE status = 'running' AND started_at < NOW() - INTERVAL '15 minutes'
      `);
      const result = await client.query(`
        SELECT id, task_key, kind, payload, priority, attempts
        FROM crawl_tasks
        WHERE status = 'queued' AND available_at <= NOW()
        ORDER BY
          (
            priority +
            LEAST(
              60,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - available_at)) / 600)::int
            )
          ) DESC,
          available_at ASC,
          id ASC
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
      { feed: '/new', priority: 130, everyMs: 20 * 60 * 1000, origin: 'unknown' },
      { feed: '/topday', priority: 126, everyMs: 45 * 60 * 1000, origin: 'unknown' },
      { feed: '/foreign', priority: 116, everyMs: 2 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/topweek', priority: 108, everyMs: 6 * 60 * 60 * 1000, origin: 'unknown' },
      { feed: '/turkish', priority: 102, everyMs: 8 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/arabic', priority: 102, everyMs: 8 * 60 * 60 * 1000, origin: 'foreign' },
    ];
    const now = Date.now();
    await Promise.all(feeds.map(item => {
      const bucket = Math.floor(now / item.everyMs);
      return this.enqueueTask('feed', item, {
        priority: item.priority,
        taskKey: `feed:${item.feed}:${bucket}`,
      });
    }));

    const homeEveryMs = 12 * 60 * 60 * 1000;
    const homeBucket = Math.floor(now / homeEveryMs);
    await this.enqueueTask('home_discovery', { maxSections: 8 }, {
      priority: 94,
      taskKey: `home_discovery:${homeBucket}`,
    });
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
