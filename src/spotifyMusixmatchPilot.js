import { config } from './config.js';
import { getArchiveDb } from './archiveDb.js';
import {
  artistCreditCompatible,
  crossScriptIdentityCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const PILOT_VERSION = 'spotify-musixmatch-v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function artistMatches(expected = '', actual = '') {
  return artistCreditCompatible(expected, actual)
    || crossScriptIdentityCompatible(expected, actual);
}

export function scoreSpotifyCandidate(track = {}, candidate = {}) {
  const title = clean(candidate?.name);
  const artists = (candidate?.artists || []).map(x => clean(x?.name)).filter(Boolean);
  const titleOk = Boolean(title) && trackTitleIdentityCompatible(track.title, title);
  const artistOk = artists.some(name => artistMatches(track.artist_display, name));
  const expectedDuration = Number(track.duration_seconds || 0) || null;
  const actualDuration = Number(candidate.duration_ms || 0) / 1000 || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;
  const exact = titleOk && artistOk && durationOk;
  const score = (titleOk ? 100 : 0)
    + (artistOk ? 100 : 0)
    + (durationDelta == null ? 0 : Math.max(0, 30 - durationDelta * 3));
  return { exact, score, titleOk, artistOk, durationOk, durationDelta };
}

export function scoreMusixmatchCandidate(track = {}, candidate = {}) {
  const title = clean(candidate?.track_name);
  const artist = clean(candidate?.artist_name);
  const titleOk = Boolean(title) && trackTitleIdentityCompatible(track.title, title);
  const artistOk = Boolean(artist) && artistMatches(track.artist_display, artist);
  const expectedDuration = Number(track.duration_seconds || 0) || null;
  const actualDuration = Number(candidate?.track_length || 0) || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;
  const exact = titleOk && artistOk && durationOk;
  const score = (titleOk ? 100 : 0)
    + (artistOk ? 100 : 0)
    + (durationDelta == null ? 0 : Math.max(0, 30 - durationDelta * 3));
  return { exact, score, titleOk, artistOk, durationOk, durationDelta };
}

async function fetchJson(url, options = {}, { retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after') || 1);
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }
    if (!response.ok) {
      lastError = new Error(`HTTP ${response.status} for ${new URL(url).origin}`);
      if (response.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
    return response.json();
  }
  throw lastError || new Error('request failed');
}

async function spotifyToken() {
  const basic = Buffer.from(
    `${config.spotifyClientId}:${config.spotifyClientSecret}`
  ).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const payload = await fetchJson(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );
  return payload.access_token;
}

async function spotifySearchTrack(track, token) {
  const q = `track:${track.title} artist:${track.artist_display}`;
  const params = new URLSearchParams({
    q,
    type: 'track',
    limit: '10',
    market: config.spotifyMarket || 'US',
  });
  const data = await fetchJson(
    `https://api.spotify.com/v1/search?${params}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const items = data?.tracks?.items || [];
  const scored = items
    .map(item => ({ item, evidence: scoreSpotifyCandidate(track, item) }))
    .filter(x => x.evidence.exact)
    .sort((a, b) => b.evidence.score - a.evidence.score);
  if (!scored.length) return { status: 'no_match', candidate: null, evidence: null };

  const best = scored[0];
  const second = scored[1];
  const ambiguous = Boolean(
    second
    && second.evidence.score >= best.evidence.score - 2
    && second.item.id !== best.item.id
    && (second.item.external_ids?.isrc || null) !== (best.item.external_ids?.isrc || null)
  );
  return {
    status: ambiguous ? 'ambiguous' : 'exact',
    candidate: best.item,
    evidence: best.evidence,
  };
}

async function musixmatchMatch(track, spotify) {
  const params = new URLSearchParams({
    apikey: config.musixmatchApiKey,
    q_track: track.title,
    q_artist: track.artist_display,
    f_has_lyrics: '1',
  });
  if (spotify?.external_ids?.isrc) params.set('track_isrc', spotify.external_ids.isrc);
  const data = await fetchJson(
    `https://api.musixmatch.com/ws/1.1/matcher.track.get?${params}`
  );
  const header = data?.message?.header || {};
  if (Number(header.status_code || 0) !== 200) {
    return { status: 'no_match', candidate: null, evidence: null };
  }
  const candidate = data?.message?.body?.track || null;
  if (!candidate) return { status: 'no_match', candidate: null, evidence: null };
  const evidence = scoreMusixmatchCandidate(track, candidate);
  return {
    status: evidence.exact ? 'exact' : 'identity_mismatch',
    candidate,
    evidence,
  };
}

async function musixmatchLyrics(trackId) {
  const params = new URLSearchParams({
    apikey: config.musixmatchApiKey,
    track_id: String(trackId),
  });
  const data = await fetchJson(
    `https://api.musixmatch.com/ws/1.1/track.lyrics.get?${params}`
  );
  const lyrics = data?.message?.body?.lyrics || null;
  if (!lyrics) return null;
  const body = String(lyrics.lyrics_body || '');
  return {
    lyricsId: lyrics.lyrics_id || null,
    restricted: Boolean(Number(lyrics.restricted || 0)),
    explicit: lyrics.explicit ?? null,
    language: lyrics.lyrics_language || null,
    bodyChars: body.length,
    hasBody: body.trim().length > 0,
    updatedTime: lyrics.updated_time || null,
  };
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS spotify_musixmatch_pilot_results (
      pilot_version TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_id TEXT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      duration_seconds NUMERIC,
      spotify_status TEXT,
      spotify_track_id TEXT,
      spotify_artist_id TEXT,
      spotify_url TEXT,
      spotify_isrc TEXT,
      spotify_duration_seconds NUMERIC,
      spotify_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      musixmatch_status TEXT,
      musixmatch_track_id TEXT,
      musixmatch_commontrack_id TEXT,
      musixmatch_has_lyrics BOOLEAN,
      musixmatch_lyrics_id TEXT,
      musixmatch_restricted BOOLEAN,
      musixmatch_language TEXT,
      musixmatch_body_chars INTEGER,
      musixmatch_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pilot_version, source_url)
    );
  `);
}

async function selectSample(db, limit = 200) {
  const artistLimit = Math.max(1, Math.floor(limit / 2));
  const { rows } = await db.query(`
    WITH core AS (
      SELECT lower(btrim(display_name)) AS artist_norm, display_name
      FROM rj_artists
      WHERE image_kind='artist_profile'
        AND image_url IS NOT NULL
        AND btrim(image_url)<>''
    ),
    missing AS (
      SELECT
        c.display_name AS core_artist,
        t.source_id, t.source_url, t.source_slug,
        t.artist_display, t.artist_farsi, t.title, t.title_farsi,
        t.album_title, t.release_date, t.duration_seconds,
        row_number() OVER (
          PARTITION BY lower(btrim(t.artist_display))
          ORDER BY
            CASE WHEN t.duration_seconds IS NULL THEN 1 ELSE 0 END,
            t.release_date DESC NULLS LAST,
            md5(t.source_url)
        ) AS rn,
        count(*) OVER (
          PARTITION BY lower(btrim(t.artist_display))
        ) AS missing_count
      FROM rj_tracks t
      JOIN core c ON lower(btrim(t.artist_display))=c.artist_norm
      WHERE t.lyrics_text IS NULL OR btrim(t.lyrics_text)=''
    ),
    eligible_artists AS (
      SELECT core_artist, max(missing_count)::int missing_count
      FROM missing
      GROUP BY core_artist
      HAVING max(missing_count) >= 2
      ORDER BY md5(lower(core_artist) || ':spotify-musixmatch-pilot-v1')
      LIMIT $1
    )
    SELECT m.*
    FROM missing m
    JOIN eligible_artists e ON e.core_artist=m.core_artist
    WHERE m.rn <= 2
    ORDER BY md5(lower(m.core_artist) || ':spotify-musixmatch-pilot-v1'), m.rn
    LIMIT $2;
  `, [artistLimit, limit]);
  return rows;
}

async function saveResult(db, track, result) {
  await db.query(`
    INSERT INTO spotify_musixmatch_pilot_results (
      pilot_version, source_url, source_id, artist, title, duration_seconds,
      spotify_status, spotify_track_id, spotify_artist_id, spotify_url,
      spotify_isrc, spotify_duration_seconds, spotify_evidence,
      musixmatch_status, musixmatch_track_id, musixmatch_commontrack_id,
      musixmatch_has_lyrics, musixmatch_lyrics_id, musixmatch_restricted,
      musixmatch_language, musixmatch_body_chars, musixmatch_evidence,
      error, tested_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
      $14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,NOW()
    )
    ON CONFLICT (pilot_version, source_url) DO UPDATE SET
      spotify_status=EXCLUDED.spotify_status,
      spotify_track_id=EXCLUDED.spotify_track_id,
      spotify_artist_id=EXCLUDED.spotify_artist_id,
      spotify_url=EXCLUDED.spotify_url,
      spotify_isrc=EXCLUDED.spotify_isrc,
      spotify_duration_seconds=EXCLUDED.spotify_duration_seconds,
      spotify_evidence=EXCLUDED.spotify_evidence,
      musixmatch_status=EXCLUDED.musixmatch_status,
      musixmatch_track_id=EXCLUDED.musixmatch_track_id,
      musixmatch_commontrack_id=EXCLUDED.musixmatch_commontrack_id,
      musixmatch_has_lyrics=EXCLUDED.musixmatch_has_lyrics,
      musixmatch_lyrics_id=EXCLUDED.musixmatch_lyrics_id,
      musixmatch_restricted=EXCLUDED.musixmatch_restricted,
      musixmatch_language=EXCLUDED.musixmatch_language,
      musixmatch_body_chars=EXCLUDED.musixmatch_body_chars,
      musixmatch_evidence=EXCLUDED.musixmatch_evidence,
      error=EXCLUDED.error,
      tested_at=NOW()
  `, [
    PILOT_VERSION,
    track.source_url,
    track.source_id,
    track.artist_display,
    track.title,
    track.duration_seconds || null,
    result.spotifyStatus || null,
    result.spotify?.id || null,
    result.spotifyArtistId || null,
    result.spotify?.external_urls?.spotify || null,
    result.spotify?.external_ids?.isrc || null,
    result.spotify?.duration_ms ? Number(result.spotify.duration_ms) / 1000 : null,
    JSON.stringify(result.spotifyEvidence || {}),
    result.musixmatchStatus || null,
    result.musixmatch?.track_id ? String(result.musixmatch.track_id) : null,
    result.musixmatch?.commontrack_id ? String(result.musixmatch.commontrack_id) : null,
    result.lyrics ? Boolean(result.lyrics.hasBody) : false,
    result.lyrics?.lyricsId ? String(result.lyrics.lyricsId) : null,
    result.lyrics?.restricted ?? null,
    result.lyrics?.language || null,
    result.lyrics?.bodyChars ?? null,
    JSON.stringify(result.musixmatchEvidence || {}),
    result.error || null,
  ]);
}

export async function getSpotifyMusixmatchPilotSummary() {
  const db = getArchiveDb();
  if (!db) return { enabled:false, reason:'archive_db_missing' };
  await ensureSchema(db);
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS tested,
      COUNT(*) FILTER (WHERE spotify_status='exact')::int AS spotify_exact,
      COUNT(*) FILTER (WHERE spotify_status='ambiguous')::int AS spotify_ambiguous,
      COUNT(*) FILTER (WHERE spotify_status='no_match')::int AS spotify_no_match,
      COUNT(*) FILTER (WHERE spotify_isrc IS NOT NULL)::int AS with_isrc,
      COUNT(*) FILTER (WHERE musixmatch_status='exact')::int AS musixmatch_exact,
      COUNT(*) FILTER (WHERE musixmatch_has_lyrics=TRUE)::int AS lyrics_available,
      COUNT(*) FILTER (WHERE musixmatch_restricted=TRUE)::int AS lyrics_restricted,
      COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
      MAX(tested_at) AS latest_tested_at
    FROM spotify_musixmatch_pilot_results
    WHERE pilot_version=$1
  `, [PILOT_VERSION]);
  return { pilotVersion:PILOT_VERSION, ...(rows[0] || {}) };
}

export async function runSpotifyMusixmatchPilot({ limit = 200 } = {}) {
  if (!config.spotifyClientId || !config.spotifyClientSecret || !config.musixmatchApiKey) {
    return {
      ok:false,
      reason:'credentials_missing',
      need:['SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','MUSIXMATCH_API_KEY'],
    };
  }
  const db = getArchiveDb();
  if (!db) return { ok:false, reason:'archive_db_missing' };
  await ensureSchema(db);
  const sample = await selectSample(db, Math.max(2, Math.min(200, Number(limit) || 200)));
  const token = await spotifyToken();

  for (let index = 0; index < sample.length; index += 1) {
    const track = sample[index];
    const result = {};
    try {
      const spotifyMatch = await spotifySearchTrack(track, token);
      result.spotifyStatus = spotifyMatch.status;
      result.spotify = spotifyMatch.candidate;
      result.spotifyEvidence = spotifyMatch.evidence;
      if (spotifyMatch.status === 'exact' && spotifyMatch.candidate) {
        const expectedArtist = track.artist_display;
        const matchedArtist = (spotifyMatch.candidate.artists || [])
          .find(artist => artistMatches(expectedArtist, artist?.name || ''));
        result.spotifyArtistId = matchedArtist?.id || null;

        const mxm = await musixmatchMatch(track, spotifyMatch.candidate);
        result.musixmatchStatus = mxm.status;
        result.musixmatch = mxm.candidate;
        result.musixmatchEvidence = mxm.evidence;
        if (mxm.status === 'exact' && mxm.candidate?.track_id) {
          result.lyrics = await musixmatchLyrics(mxm.candidate.track_id);
        }
      }
    } catch (err) {
      result.error = String(err?.message || err).slice(0, 1000);
    }
    await saveResult(db, track, result);
    if ((index + 1) % 20 === 0) {
      console.log('[spotify musixmatch pilot] progress', JSON.stringify({
        done:index + 1,
        total:sample.length,
      }));
    }
    await sleep(120);
  }

  const summary = await getSpotifyMusixmatchPilotSummary();
  console.log('[spotify musixmatch pilot] complete', JSON.stringify(summary));
  return { ok:true, sampleSize:sample.length, ...summary };
}
