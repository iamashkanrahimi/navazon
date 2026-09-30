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

export function stableSourceTrackVariant(value = '') {
  const cleaned = cleanText(value)
    .replace(/^#?\s*[۰-۹٠-٩0-9]+\s+[🎵🎶🎧]\s*/u, '')
    .replace(
      /\s+x\s+(?:<\s*)?[۰-۹٠-٩0-9]+(?:[.,][۰-۹٠-٩0-9]+)?\s*[kKmMgG]?(?:\s*[.…]+)?\s*$/u,
      ''
    )
    .trim();
  return normalizeText(cleaned);
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

export function artistCreditParts(value = '') {
  return cleanText(value)
    .split(/\s*(?:&|\bx\b|,|feat\.?|ft\.?|featuring)\s*/iu)
    .map(normalizeText)
    .filter(Boolean);
}

export function artistCreditMatchesContext(credit = '', artist = '') {
  const target = normalizeText(artist);
  const actual = normalizeText(credit);
  if (!target || !actual) return false;
  if (target === actual) return true;

  const wantedParts = artistCreditParts(artist);
  const actualParts = artistCreditParts(credit);
  if (!wantedParts.length || !actualParts.length) return false;

  if (wantedParts.length === 1) {
    return actualParts.includes(wantedParts[0]);
  }
  return wantedParts.every(part => actualParts.includes(part));
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

const TRACK_VARIANT_WORDS = new Set([
  'remix', 'mix', 'edit', 'version', 'live', 'acoustic', 'instrumental',
  'remaster', 'remastered', 'rework', 'sped', 'slowed', 'karaoke',
  'ریمیکس', 'لایو', 'آکوستیک', 'بیکلام', 'بی‌کلام',
]);

export function unrequestedTrackVariantWords(query = '', track = {}) {
  const querySet = new Set(
    normalizeText(query).split(' ').filter(Boolean)
  );
  const titleTokens = normalizeText(track?.title || '')
    .split(' ')
    .filter(Boolean);

  return titleTokens.filter(token =>
    TRACK_VARIANT_WORDS.has(token) && !querySet.has(token)
  );
}

export function primarySearchQueries(query = '') {
  const full = cleanText(query);
  if (!full) return [];

  const base = full
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '')
    .trim();

  if (base === full) return [full];

  // Explicit version intent is more important than shaving a source round
  // trip: "feat ... remix/live" must not silently fall back to the original.
  const hasVariantIntent = /(?:^|\s)(?:remix|live|acoustic|version|edit|mix|ریمیکس|اجرای\s*زنده|آکوستیک)(?:\s|$)/iu
    .test(full);
  return [...new Set(
    (hasVariantIntent ? [full, base] : [base, full]).filter(Boolean)
  )];
}

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

  const unrequestedVariants = unrequestedTrackVariantWords(query, track);
  score -= unrequestedVariants.length * 18;

  if (track.artistInferred) score -= 1;

  return {
    score,
    coverage,
    total: queryTokens.length,
    unrequestedVariants,
  };
}

export function acceptsShortenedPrimarySearch(
  originalQuery = '',
  sourceQuery = '',
  tracks = []
) {
  if (normalizeText(originalQuery) === normalizeText(sourceQuery)) return true;

  const meaningful = meaningfulSearchTokens(originalQuery);
  if (!meaningful.length) return true;

  const bestCoverage = (tracks || []).reduce(
    (best, track) =>
      Math.max(best, scoreTrackQueryMatch(originalQuery, track).coverage),
    0
  );
  return bestCoverage >= meaningful.length;
}



function scriptFamily(value = '') {
  const text = cleanText(value);
  const hasPersian = /[\u0600-\u06ff]/u.test(text);
  const hasLatin = /[a-z]/iu.test(text);
  if (hasPersian && !hasLatin) return 'persian';
  if (hasLatin && !hasPersian) return 'latin';
  return 'mixed';
}

export function crossScriptArtistConsensus(query = '', tracks = []) {
  const meaningful = meaningfulSearchTokens(query);
  if (meaningful.length !== 1 || !(tracks || []).length) return null;

  const queryScript = scriptFamily(query);
  if (queryScript === 'mixed') return null;

  const counts = new Map();
  const labels = new Map();
  for (const track of tracks || []) {
    const artist = cleanText(track?.artist || '');
    const key = normalizeText(artist);
    if (!key) continue;

    const artistScript = scriptFamily(artist);
    if (
      artistScript === 'mixed'
      || artistScript === queryScript
    ) continue;

    counts.set(key, (counts.get(key) || 0) + 1);
    labels.set(key, artist);
  }

  let bestKey = '';
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  const threshold = Math.max(2, Math.ceil((tracks || []).length * 0.8));
  if (!bestKey || bestCount < threshold) return null;

  return {
    artist: labels.get(bestKey) || bestKey,
    artistKey: bestKey,
    count: bestCount,
    total: (tracks || []).length,
  };
}

export function shouldUseSearchRelevanceFallback(
  query = '',
  bestCoverage = 0,
  bestTrack = null,
  tracks = []
) {
  const meaningful = meaningfulSearchTokens(query);
  if (!meaningful.length) return false;

  // A one-token nonsense/typo query used to accept whatever five MeloBot rows
  // happened to be visible and then cache them. Zero lexical coverage is
  // never sufficient, even for a single-token query.
  if (meaningful.length === 1) {
    if (Number(bestCoverage || 0) >= 1) return false;
    return !crossScriptArtistConsensus(query, tracks);
  }

  if (Number(bestCoverage || 0) < meaningful.length) return true;
  return unrequestedTrackVariantWords(query, bestTrack || {}).length > 0;
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

export function keepFullCoverageTracksWhenAvailable(query = '', tracks = []) {
  const tokens = meaningfulSearchTokens(query);
  if (!tokens.length || !(tracks || []).length) return tracks || [];

  const ranked = rankTracksForQuery(query, tracks);

  // For a single meaningful token, returning zero-coverage source suggestions
  // is actively misleading and poisons the search cache. Require an actual
  // lexical match.
  if (tokens.length === 1) {
    const covered = ranked
      .filter(item => item.coverage >= 1)
      .map(item => item.track);
    if (covered.length) return covered;

    // Persian artist queries often come back transliterated by MeloBot
    // (مثلاً «هیچکس» -> Hichkas). Preserve that case only when the source
    // strongly agrees on one opposite-script artist; arbitrary mixed
    // zero-coverage suggestions are still discarded.
    const consensus = crossScriptArtistConsensus(query, tracks);
    if (!consensus) return [];
    return ranked
      .filter(item => normalizeText(item.track?.artist || '') === consensus.artistKey)
      .map(item => item.track);
  }

  const full = ranked.filter(item => item.total > 0 && item.coverage === item.total);
  return (full.length ? full : ranked).map(item => item.track);
}
