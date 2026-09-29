import { canonicalMatchKey, cleanText, selectReleaseDate, splitArtistNames, stableJsonHash, truthyBool } from './utils.js';

function artistTags(raw = {}) {
  if (Array.isArray(raw.artist_tags)) return raw.artist_tags;
  if (Array.isArray(raw.artistTags)) return raw.artistTags;
  return [];
}

function albumInfo(raw = {}) {
  const album = raw.album;
  if (typeof album === 'string') return { title: cleanText(album) || cleanText(raw.album_album || '') || null, source_id: null, source_url: cleanText(raw.album_share_link || '') || null };
  if (album && typeof album === 'object') return {
    title: cleanText(album.album || album.name || album.title || raw.album_album || '') || null,
    source_id: album.id != null ? String(album.id) : null,
    source_url: cleanText(album.share_link || album.shareLink || raw.album_share_link || '') || null,
  };
  return { title: cleanText(raw.album_album || '') || null, source_id: raw.album_id != null ? String(raw.album_id) : null, source_url: cleanText(raw.album_share_link || '') || null };
}

function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function jsonValue(value) { return value == null ? null : value; }

function albumTrackRefs(raw = {}) {
  if (!Array.isArray(raw.album_tracks)) return [];
  return raw.album_tracks.map((item, index) => ({
    position: index + 1,
    source_id: item?.id != null ? String(item.id) : null,
    artist: cleanText(item?.artist || '') || null,
    title: cleanText(item?.song || item?.name || item?.title || '') || null,
    permlink: cleanText(item?.permlink || '') || null,
    share_url: cleanText(item?.share_link || '') || null,
  })).filter(x => x.source_id || x.title);
}

export function normalizeSongResponse(raw = {}, { sourceUrl, sourceSlug, rawText = '' } = {}) {
  const title = cleanText(raw.song || raw.name || raw.title || '');
  const artist = cleanText(raw.artist || raw.album_artist || '');
  if (!title || !artist) throw new Error('RJ song response is missing artist/title');

  const tags = artistTags(raw).map(cleanText).filter(Boolean);
  const artists = splitArtistNames(artist, tags);
  const album = albumInfo(raw);
  const date = selectReleaseDate(raw);
  const lyrics = raw.lyric ?? raw.lyrics ?? null;
  const sourceId = raw.id != null ? String(raw.id) : null;
  const trackRefs = albumTrackRefs(raw);

  return {
    schema_version: 2,
    source: 'radiojavan',
    source_id: sourceId,
    source_slug: sourceSlug,
    source_url: sourceUrl,
    source_share_url: cleanText(raw.share_link || '') || null,
    source_permalink: cleanText(raw.permlink || '') || null,
    canonical_match_key: canonicalMatchKey({ artist, artistTags: tags, title }),
    artist_display: artist,
    artist_farsi: cleanText(raw.artist_farsi || '') || null,
    artist_names: artists,
    artist_tags: tags,
    title,
    title_farsi: cleanText(raw.song_farsi || '') || null,
    album_title: album.title,
    album_farsi: cleanText(raw.album_farsi || '') || null,
    album_artist: cleanText(raw.album_artist || '') || null,
    album_source_id: album.source_id,
    album_source_url: album.source_url,
    album_track_count: trackRefs.length || null,
    album_track_refs: trackRefs,
    ...date,
    release_year: numberOrNull(raw.release_year),
    source_created_at: cleanText(raw.created_at || '') || null,
    duration_seconds: numberOrNull(raw.duration),
    lyrics_text: lyrics == null ? null : String(lyrics).trim() || null,
    lyrics_available: Boolean(lyrics != null && String(lyrics).trim()),
    lyrics_status: lyrics != null && String(lyrics).trim() ? 'available' : 'not_provided',
    lyrics_synced: jsonValue(raw.lyric_synced),
    credits: cleanText(raw.credits || '') || null,
    credits_list: jsonValue(raw.credits_list),
    credit_tags: Array.isArray(raw.credit_tags) ? raw.credit_tags : [],
    explicit: truthyBool(raw.explicit ?? raw.is_explicit ?? raw.has_explicit),
    cover_url: cleanText(raw.photo || raw.photo_player || raw.thumbnail || '') || null,
    response_hash: stableJsonHash(rawText, raw),
    diagnostics: {
      api_keys: Object.keys(raw).sort(),
      related_count: Array.isArray(raw.related) ? raw.related.length : null,
      album_tracks_count: Array.isArray(raw.album_tracks) ? raw.album_tracks.length : null,
    },
  };
}
