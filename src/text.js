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
  const digitMap = {
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4',
    '۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4',
    '٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
  };

  return cleanText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[۰-۹٠-٩]/g, digit => digitMap[digit] || digit)
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCompositeArtistSeparators(value = '') {
  const artist = cleanText(value);
  if (!artist) return false;

  // Background discovery treats ambiguous multi-name credits conservatively.
  // This does not redefine the artist identity for interactive navigation; it
  // only gives the crawler a cheap way to avoid manufacturing artist profiles
  // from track-level collaboration credits such as "Drake & Yeat".
  return /\s(?:&|x)\s|,\s*|\b(?:feat\.?|ft\.?|featuring)\b/iu.test(artist);
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

  // If the source transliterates the artist into a different script, token
  // subtraction is not trustworthy. Only a known album title match (handled
  // above) is strong enough to classify the query as title-specific.
  return false;
}


export function shouldUseLiveAlbumDiscovery(query = '') {
  return hasAlbumIntent(query);
}


const SEARCH_NOISE_WORDS = new Set([
  'ft', 'feat', 'featuring', 'with', 'and', 'vs',
  'the', 'a', 'an',
]);

export function meaningfulSearchTokens(query = '') {
  return normalizeText(query)
    .split(' ')
    .filter(token =>
      token.length >= 2
      && !SEARCH_NOISE_WORDS.has(token)
      && !ALBUM_INTENT_WORDS.has(token)
      && !ALBUM_SUFFIX_WORDS.has(token)
    );
}

export function scoreTrackQueryMatch(query = '', track = {}) {
  const queryTokens = meaningfulSearchTokens(query);
  if (!queryTokens.length) return { score: 0, coverage: 0, total: 0 };

  const artist = normalizeText(track.artist || '');
  const title = normalizeText(track.title || '');
  const haystack = new Set(
    normalizeText([track.artist, track.title].filter(Boolean).join(' '))
      .split(' ')
      .filter(Boolean)
  );

  let coverage = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) coverage += 1;
  }

  let score = coverage * 10;
  if (title && normalizeText(query).includes(title)) score += 8;
  if (artist && normalizeText(query).includes(artist)) score += 6;
  if (track.artistInferred) score -= 1;

  return { score, coverage, total: queryTokens.length };
}

export function shouldUseSearchRelevanceFallback(query = '', bestCoverage = 0) {
  const meaningful = meaningfulSearchTokens(query);
  return meaningful.length >= 2 && Number(bestCoverage || 0) < meaningful.length;
}

export function rankTracksForQuery(query = '', tracks = []) {
  return (tracks || [])
    .map((track, index) => ({
      track,
      index,
      ...scoreTrackQueryMatch(query, track),
    }))
    .sort((a, b) =>
      b.score - a.score
      || b.coverage - a.coverage
      || a.index - b.index
    );
}
