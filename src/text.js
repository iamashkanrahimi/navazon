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

export function hasSpecificAlbumTitle(query = '', artist = '') {
  return albumSpecificTitleTokens(query, artist).length > 0;
}
