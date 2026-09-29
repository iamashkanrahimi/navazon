export const ALBUM_INTENT_WORDS = new Set([
  'album',
  'albums',
  'آلبوم',
  'آلبومها',
  'آلبومهای',
  'البوم',
  'البومها',
  'البومهای',
]);

const ALBUM_SUFFIX_WORDS = new Set(['ها', 'های']);

export function cleanText(value = '') {
  return String(value)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(value = '') {
  return cleanText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasAlbumIntent(query = '') {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  return tokens.some(token => ALBUM_INTENT_WORDS.has(token));
}

export function albumQueryTokens(query = '') {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  const albumIntent = tokens.some(token => ALBUM_INTENT_WORDS.has(token));
  return tokens.filter(token =>
    !ALBUM_INTENT_WORDS.has(token)
    && !(albumIntent && ALBUM_SUFFIX_WORDS.has(token))
  );
}

export function albumSpecificTitleTokens(query = '', artist = '') {
  const artistTokens = new Set(
    normalizeText(artist).split(' ').filter(Boolean)
  );
  return albumQueryTokens(query).filter(token => !artistTokens.has(token));
}

export function albumTitleAppearsInQuery(query = '', albumTitle = '') {
  const queryTokens = new Set(albumQueryTokens(query));
  const titleTokens = normalizeText(albumTitle).split(' ').filter(Boolean);
  return titleTokens.length > 0 && titleTokens.every(token => queryTokens.has(token));
}

export function hasSpecificAlbumTitle(query = '', artist = '', albumTitles = []) {
  const titles = Array.isArray(albumTitles) ? albumTitles : [];
  if (titles.some(title => albumTitleAppearsInQuery(query, title))) return true;

  const queryTokens = albumQueryTokens(query);
  const artistTokens = normalizeText(artist).split(' ').filter(Boolean);
  if (!queryTokens.length || !artistTokens.length) return false;

  const artistSet = new Set(artistTokens);
  const overlapCount = queryTokens.filter(token => artistSet.has(token)).length;

  if (overlapCount > 0) {
    return queryTokens.some(token => !artistSet.has(token));
  }

  // The source can return a transliterated artist name while the user typed
  // Persian (or vice versa). In that case allow one-token variance in the
  // artist name before treating the remaining words as an album title.
  return queryTokens.length > artistTokens.length + 1;
}
