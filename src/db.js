import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});

db.on('error', err => console.error('[postgres pool]', err.message));

export async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS track_cache (
      track_key TEXT PRIMARY KEY,
      track JSONB NOT NULL,
      media JSONB NOT NULL,
      navazon_serve_count BIGINT NOT NULL DEFAULT 0,
      cache_hit_count BIGINT NOT NULL DEFAULT 0,
      source_fetch_count BIGINT NOT NULL DEFAULT 0,
      first_cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_served_at TIMESTAMPTZ
    );

    ALTER TABLE track_cache
      ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE track_cache
      ADD COLUMN IF NOT EXISTS superseded_by TEXT;

    CREATE INDEX IF NOT EXISTS track_cache_key_pattern_idx
      ON track_cache (track_key text_pattern_ops);
    CREATE INDEX IF NOT EXISTS track_cache_active_idx
      ON track_cache (active, updated_at DESC);
    CREATE INDEX IF NOT EXISTS track_cache_updated_idx
      ON track_cache (updated_at DESC);

    CREATE TABLE IF NOT EXISTS artists (
      artist_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS searches (
      query_key TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS follows (
      user_id BIGINT NOT NULL,
      artist_key TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      followed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, artist_key)
    );

    CREATE INDEX IF NOT EXISTS follows_artist_idx ON follows (artist_key);

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      data JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crawler_runs (
      id BIGSERIAL PRIMARY KEY,
      artist TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      ok BOOLEAN,
      summary JSONB,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS crawler_runs_finished_idx
      ON crawler_runs (finished_at DESC);

    CREATE TABLE IF NOT EXISTS deep_tracks (
      track_key TEXT PRIMARY KEY,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      album TEXT,
      duration_seconds INTEGER,
      release_date DATE,
      release_date_raw TEXT,
      popularity_count BIGINT,
      popularity_text TEXT,
      content_origin TEXT NOT NULL DEFAULT 'unknown',
      availability_policy TEXT NOT NULL DEFAULT 'unknown',
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      lyrics_text TEXT,
      lyrics_source TEXT,
      lyrics_updated_at TIMESTAMPTZ,
      cover_file_id TEXT,
      cover_unique_id TEXT,
      cover_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS deep_tracks_artist_idx ON deep_tracks (artist);
    CREATE INDEX IF NOT EXISTS deep_tracks_updated_idx ON deep_tracks (updated_at DESC);
    CREATE INDEX IF NOT EXISTS deep_tracks_discovered_idx ON deep_tracks (discovered_at DESC);

    CREATE TABLE IF NOT EXISTS track_aliases (
      alias_key TEXT PRIMARY KEY,
      alias_artist TEXT NOT NULL,
      alias_title TEXT NOT NULL,
      canonical_track_key TEXT NOT NULL REFERENCES deep_tracks(track_key) ON DELETE CASCADE,
      source TEXT,
      evidence TEXT NOT NULL DEFAULT 'unknown',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS track_aliases_canonical_idx
      ON track_aliases (canonical_track_key);

    CREATE TABLE IF NOT EXISTS track_capability_failures (
      track_key TEXT NOT NULL REFERENCES deep_tracks(track_key) ON DELETE CASCADE,
      capability TEXT NOT NULL,
      reason TEXT,
      failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (track_key, capability)
    );

    CREATE INDEX IF NOT EXISTS track_capability_failures_failed_idx
      ON track_capability_failures (failed_at DESC);

    CREATE TABLE IF NOT EXISTS deep_track_media (
      track_key TEXT NOT NULL REFERENCES deep_tracks(track_key) ON DELETE CASCADE,
      quality TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_unique_id TEXT,
      kind TEXT NOT NULL DEFAULT 'audio',
      bitrate INTEGER,
      file_size BIGINT,
      duration_seconds INTEGER,
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (track_key, quality)
    );

    ALTER TABLE deep_track_media
      ADD COLUMN IF NOT EXISTS verified_quality BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS deep_albums (
      album_key TEXT PRIMARY KEY,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      track_count INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      cover_file_id TEXT,
      cover_unique_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deep_album_tracks (
      album_key TEXT NOT NULL REFERENCES deep_albums(album_key) ON DELETE CASCADE,
      track_key TEXT NOT NULL REFERENCES deep_tracks(track_key) ON DELETE CASCADE,
      position INTEGER,
      PRIMARY KEY (album_key, track_key)
    );

    CREATE TABLE IF NOT EXISTS deep_artist_tracks (
      artist_key TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      list_type TEXT NOT NULL,
      track_key TEXT NOT NULL REFERENCES deep_tracks(track_key) ON DELETE CASCADE,
      rank INTEGER,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (artist_key, list_type, track_key)
    );

    ALTER TABLE deep_artist_tracks
      ADD COLUMN IF NOT EXISTS list_version INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS crawl_tasks (
      id BIGSERIAL PRIMARY KEY,
      task_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS crawl_tasks_ready_idx
      ON crawl_tasks (status, priority DESC, available_at, id);
    CREATE INDEX IF NOT EXISTS crawl_tasks_completed_idx
      ON crawl_tasks (completed_at DESC)
      WHERE completed_at IS NOT NULL;
  `);
}
