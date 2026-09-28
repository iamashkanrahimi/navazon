import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 2,
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
  `);
}
