import { db } from './db.js';
import { getArchiveDb } from './archiveDb.js';
import { deepTrackKey } from './deepCatalog.js';
import { getState, setState } from './state.js';

const STATE_KEY = 'rj_lyrics_backfill_v1';
const BATCH_SIZE = 250;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

async function ensureProductionLyricsSchema() {
  await db.query(`
    ALTER TABLE deep_tracks
      ADD COLUMN IF NOT EXISTS lyrics_synced JSONB;
    ALTER TABLE deep_tracks
      ADD COLUMN IF NOT EXISTS lyrics_integrity JSONB;
  `);
}

async function productionLyricsSummary() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE lyrics_text IS NOT NULL AND BTRIM(lyrics_text) <> ''
      )::int AS with_lyrics,
      COUNT(*) FILTER (
        WHERE lyrics_source='radiojavan'
          AND lyrics_text IS NOT NULL
          AND BTRIM(lyrics_text) <> ''
      )::int AS from_radiojavan,
      COUNT(*) FILTER (
        WHERE lyrics_synced IS NOT NULL
          AND jsonb_typeof(lyrics_synced)='array'
          AND jsonb_array_length(lyrics_synced) > 0
      )::int AS with_synced
    FROM deep_tracks
  `);
  return rows[0] || {};
}

async function upsertBatch(rows) {
  const payload = rows.map(row => {
    const track = {
      artist: clean(row.artist_display),
      title: clean(row.title),
    };
    return {
      track_key: deepTrackKey(track),
      artist: track.artist,
      title: track.title,
      album: clean(row.album_title) || null,
      duration_seconds: toDuration(row.duration_seconds),
      release_date: row.release_date || null,
      release_date_raw: clean(row.release_date_raw) || null,
      source_id: row.source_id || null,
      source_url: row.source_url || null,
      lyrics_text: String(row.lyrics_text || '').trim(),
      lyrics_synced: Array.isArray(row.lyrics_synced) ? row.lyrics_synced : [],
      lyrics_integrity: row.lyrics_integrity || {},
    };
  }).filter(row => row.track_key && row.artist && row.title && row.lyrics_text);

  if (!payload.length) return { affected: 0 };

  const result = await db.query(`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        track_key text,
        artist text,
        title text,
        album text,
        duration_seconds integer,
        release_date date,
        release_date_raw text,
        source_id text,
        source_url text,
        lyrics_text text,
        lyrics_synced jsonb,
        lyrics_integrity jsonb
      )
    )
    INSERT INTO deep_tracks (
      track_key, artist, title, album, duration_seconds,
      release_date, release_date_raw,
      content_origin, source_data, metadata,
      lyrics_text, lyrics_source, lyrics_updated_at,
      lyrics_synced, lyrics_integrity,
      updated_at
    )
    SELECT
      track_key,
      artist,
      title,
      album,
      duration_seconds,
      release_date,
      release_date_raw,
      'radiojavan',
      jsonb_build_object(
        'radiojavan',
        jsonb_build_object(
          'sourceId', source_id,
          'sourceUrl', source_url
        )
      ),
      jsonb_build_object('hasLyrics', true),
      lyrics_text,
      'radiojavan',
      NOW(),
      CASE
        WHEN jsonb_typeof(lyrics_synced)='array' THEN lyrics_synced
        ELSE '[]'::jsonb
      END,
      COALESCE(lyrics_integrity, '{}'::jsonb),
      NOW()
    FROM incoming
    ON CONFLICT (track_key) DO UPDATE SET
      album = COALESCE(deep_tracks.album, EXCLUDED.album),
      duration_seconds = COALESCE(deep_tracks.duration_seconds, EXCLUDED.duration_seconds),
      release_date = COALESCE(deep_tracks.release_date, EXCLUDED.release_date),
      release_date_raw = COALESCE(deep_tracks.release_date_raw, EXCLUDED.release_date_raw),
      content_origin = CASE
        WHEN deep_tracks.content_origin='unknown' THEN 'radiojavan'
        ELSE deep_tracks.content_origin
      END,
      source_data = deep_tracks.source_data || EXCLUDED.source_data,
      metadata = deep_tracks.metadata || '{"hasLyrics":true}'::jsonb,
      lyrics_text = CASE
        WHEN deep_tracks.lyrics_text IS NULL OR BTRIM(deep_tracks.lyrics_text)=''
          THEN EXCLUDED.lyrics_text
        ELSE deep_tracks.lyrics_text
      END,
      lyrics_source = CASE
        WHEN deep_tracks.lyrics_text IS NULL OR BTRIM(deep_tracks.lyrics_text)=''
          THEN 'radiojavan'
        ELSE deep_tracks.lyrics_source
      END,
      lyrics_updated_at = CASE
        WHEN deep_tracks.lyrics_text IS NULL OR BTRIM(deep_tracks.lyrics_text)=''
          THEN NOW()
        ELSE deep_tracks.lyrics_updated_at
      END,
      lyrics_synced = CASE
        WHEN (
          deep_tracks.lyrics_text IS NULL
          OR BTRIM(deep_tracks.lyrics_text)=''
          OR deep_tracks.lyrics_source='radiojavan'
        )
        AND EXCLUDED.lyrics_synced IS NOT NULL
        AND jsonb_typeof(EXCLUDED.lyrics_synced)='array'
        AND jsonb_array_length(EXCLUDED.lyrics_synced)>0
          THEN EXCLUDED.lyrics_synced
        ELSE deep_tracks.lyrics_synced
      END,
      lyrics_integrity = CASE
        WHEN deep_tracks.lyrics_text IS NULL
          OR BTRIM(deep_tracks.lyrics_text)=''
          OR deep_tracks.lyrics_source='radiojavan'
          THEN EXCLUDED.lyrics_integrity
        ELSE deep_tracks.lyrics_integrity
      END,
      updated_at = NOW()
    RETURNING track_key
  `, [JSON.stringify(payload)]);

  return { affected: result.rowCount || 0 };
}

export async function runRjLyricsBackfill({ force = false } = {}) {
  const archiveDb = getArchiveDb();
  if (!archiveDb) return { ok: false, reason: 'archive_db_missing' };

  await ensureProductionLyricsSchema();

  const saved = await getState(STATE_KEY, null);
  if (!force && saved?.complete) {
    return { ok: true, skipped: true, reason: 'already_complete', ...saved };
  }

  const before = await productionLyricsSummary();
  let cursor = '';
  let scanned = 0;
  let affected = 0;
  let batches = 0;

  await setState(STATE_KEY, {
    complete: false,
    startedAt: new Date().toISOString(),
    scanned: 0,
    affected: 0,
  });

  while (true) {
    const { rows } = await archiveDb.query(`
      SELECT
        source_url, source_id, artist_display, title,
        album_title, duration_seconds,
        release_date, release_date_raw,
        lyrics_text, lyrics_synced, lyrics_integrity
      FROM rj_tracks
      WHERE lyrics_text IS NOT NULL
        AND BTRIM(lyrics_text) <> ''
        AND source_url > $1
      ORDER BY source_url
      LIMIT $2
    `, [cursor, BATCH_SIZE]);

    if (!rows.length) break;

    const result = await upsertBatch(rows);
    scanned += rows.length;
    affected += result.affected;
    batches += 1;
    cursor = rows[rows.length - 1].source_url;

    if (batches % 10 === 0) {
      console.log('[rj lyrics backfill] progress', JSON.stringify({
        scanned, affected, cursor,
      }));
      await setState(STATE_KEY, {
        complete: false,
        startedAt: saved?.startedAt || new Date().toISOString(),
        scanned,
        affected,
        cursor,
      });
    }
  }

  const after = await productionLyricsSummary();
  const summary = {
    complete: true,
    completedAt: new Date().toISOString(),
    scanned,
    affected,
    batches,
    before,
    after,
  };
  await setState(STATE_KEY, summary);
  console.log('[rj lyrics backfill] complete', JSON.stringify(summary));
  return { ok: true, ...summary };
}
