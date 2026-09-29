import {
  canonicalMatchKey,
  cleanText,
  selectReleaseDate,
  splitArtistNames,
  stableJsonHash,
  truthyBool,
} from './utils.js';

function artistTags(raw = {}) {
  if (Array.isArray(raw.artist_tags)) return raw.artist_tags;
  if (Array.isArray(raw.artistTags)) return raw.artistTags;
  return [];
}

function albumInfo(raw = {}) {
  const album = raw.album;
  if (typeof album === 'string') {
    return { title: cleanText(album) || null, source_id: null, source_url: null };
  }
  if (album && typeof album === 'object') {
    return {
      title: cleanText(album.album || album.name || album.title || raw.album_album || '') || null,
      source_id: album.id != null ? String(album.id) : null,
      source_url: cleanText(album.share_link || album.shareLink || '') || null,
    };
  }
  return {
    title: cleanText(raw.album_album || '') || null,
    source_id: raw.album_id != null ? String(raw.album_id) : null,
    source_url: cleanText(raw.album_share_link || '') || null,
  };
}

function integerOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
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

  return {
    schema_version: 1,
    source: 'radiojavan',
    source_id: sourceId,
    source_slug: sourceSlug,
    source_url: sourceUrl,
    canonical_match_key: canonicalMatchKey({ artist, artistTags: tags, title }),
    artist_display: artist,
    artist_names: artists,
    artist_tags: tags,
    title,
    album_title: album.title,
    album_source_id: album.source_id,
    album_source_url: album.source_url,
    ...date,
    source_created_at: cleanText(raw.created_at || '') || null,
    duration_seconds: integerOrNull(raw.duration),
    lyrics_text: lyrics == null ? null : String(lyrics).trim() || null,
    lyrics_available: Boolean(lyrics != null && String(lyrics).trim()),
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
