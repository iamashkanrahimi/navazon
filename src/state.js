import { db } from './db.js';

export async function setState(key, value) {
  await db.query(`
    INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

export async function getState(key, fallback = null) {
  const result = await db.query('SELECT value FROM app_state WHERE key = $1', [key]);
  return result.rowCount ? result.rows[0].value : fallback;
}

export async function recordCrawlerStart(artist = null) {
  const result = await db.query(
    'INSERT INTO crawler_runs (artist) VALUES ($1) RETURNING id',
    [artist]
  );
  return result.rows[0].id;
}

export async function recordCrawlerFinish(id, { ok, summary = null, error = null } = {}) {
  await db.query(`
    UPDATE crawler_runs
    SET finished_at = NOW(), ok = $2, summary = $3::jsonb, error = $4
    WHERE id = $1
  `, [id, Boolean(ok), JSON.stringify(summary || {}), error ? String(error).slice(0, 1000) : null]);
}

export async function getStats() {
  const [artists, cache, follows, crawler, sessions, deepTracks, deepMedia, deepTasks, deepAlbums, deepLists, productivity] = await Promise.all([
    db.query(`SELECT COUNT(*)::bigint AS artists,
      COALESCE(SUM(jsonb_object_length(COALESCE(data->'tracks','{}'::jsonb))),0)::bigint AS tracks,
      COALESCE(SUM(jsonb_array_length(COALESCE(data->'albumList','[]'::jsonb))),0)::bigint AS albums
      FROM artists`),
    db.query(`SELECT COUNT(*)::bigint AS cached_tracks,
      COALESCE(SUM(navazon_serve_count),0)::bigint AS serves,
      COALESCE(SUM(cache_hit_count),0)::bigint AS cache_hits,
      COALESCE(SUM(source_fetch_count),0)::bigint AS source_fetches
      FROM track_cache`),
    db.query('SELECT COUNT(*)::bigint AS follows FROM follows'),
    db.query(`SELECT COUNT(*)::bigint AS runs,
      COUNT(*) FILTER (WHERE ok = true)::bigint AS successful,
      COUNT(*) FILTER (WHERE ok = false)::bigint AS failed,
      MAX(finished_at) AS last_finished_at
      FROM crawler_runs`),
    db.query('SELECT COUNT(*)::bigint AS active_sessions FROM sessions WHERE expires_at > NOW()'),
    db.query(`SELECT COUNT(*)::bigint AS tracks,
      COUNT(*) FILTER (WHERE lyrics_text IS NOT NULL AND lyrics_text <> '')::bigint AS lyrics,
      COUNT(*) FILTER (WHERE cover_file_id IS NOT NULL)::bigint AS covers,
      COUNT(*) FILTER (WHERE release_date IS NOT NULL OR release_date_raw IS NOT NULL)::bigint AS release_dates
      FROM deep_tracks`),
    db.query(`SELECT COUNT(*)::bigint AS media,
      COUNT(*) FILTER (WHERE quality = 'hq')::bigint AS hq,
      COUNT(*) FILTER (WHERE quality = 'normal')::bigint AS normal
      FROM deep_track_media`),
    db.query(`SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
      COUNT(*) FILTER (WHERE status = 'running')::bigint AS running,
      COUNT(*) FILTER (WHERE status = 'done')::bigint AS done,
      COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
      FROM crawl_tasks`),
    db.query('SELECT COUNT(*)::bigint AS albums FROM deep_albums'),
    db.query(`SELECT
      COUNT(*) FILTER (WHERE list_type = 'recent')::bigint AS recent_rows,
      COUNT(*) FILTER (WHERE list_type = 'top')::bigint AS top_rows
      FROM deep_artist_tracks`),
    db.query(`
      SELECT
        (SELECT COUNT(*) FROM deep_tracks WHERE discovered_at >= NOW() - INTERVAL '24 hours')::bigint AS tracks_24h,
        (SELECT COUNT(*) FROM deep_track_media WHERE updated_at >= NOW() - INTERVAL '24 hours')::bigint AS media_24h,
        (SELECT COUNT(*) FROM crawl_tasks WHERE completed_at >= NOW() - INTERVAL '24 hours' AND status = 'done')::bigint AS tasks_done_24h,
        (SELECT COUNT(*) FROM crawler_runs WHERE finished_at >= NOW() - INTERVAL '24 hours' AND ok = true)::bigint AS successful_runs_24h,
        (SELECT COUNT(*) FROM crawler_runs WHERE finished_at >= NOW() - INTERVAL '24 hours' AND ok = false)::bigint AS failed_runs_24h
    `),
  ]);
  const toNum = row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v]));
  return {
    catalog: toNum(artists.rows[0]),
    cache: toNum(cache.rows[0]),
    follows: toNum(follows.rows[0]),
    crawler: toNum(crawler.rows[0]),
    sessions: toNum(sessions.rows[0]),
    deepCatalog: {
      tracks: toNum(deepTracks.rows[0]),
      media: toNum(deepMedia.rows[0]),
      tasks: toNum(deepTasks.rows[0]),
      albums: toNum(deepAlbums.rows[0]),
      artistLists: toNum(deepLists.rows[0]),
      productivity24h: toNum(productivity.rows[0]),
    },
  };
}
