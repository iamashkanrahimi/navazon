import { config } from '../config.js';
import { CURATED_PLAYLISTS, curatedPlaylistByKey } from '../homeCatalog.js';
import {
  cleanText,
  normalizeText,
  hasAlbumIntent,
  albumSpecificTitleTokens,
} from '../text.js';
import {
  collectNewMessages,
  isAudioMessage,
  latestMessageId,
  messageText,
} from '../mtproto.js';

let sourceStateVersion = 0;

export function getMeloBotStateVersion() {
  return sourceStateVersion;
}

const CONTROL_WORDS = [
  'صفحه اصلی',
  'جستجوی عمیق',
  'خرید اشتراک',
  'کیفیت معمولی',
  'کیفیت عالی',
  'آهنگهای مشابه',
  'آهنگ های مشابه',
  'متن آهنگ',
  'لینک اشتراک',
  'دانلود همه',
  'فالو کردن',
  'آنفالو',
  'ترتیب',
  'پیشنهاد',
  'دمو',
  'تبلیغ',
  'بیشتر',
  'بازگشت',
  'بعدی',
  'قبلی',
  'صفحه بعد',
  'صفحه قبل',
  'ادامه',
  'آهنگ در لیست نیست',
  'آهنگ مورد نظر در لیست نیست',
  'در لیست نیست',
];

function clean(value = '') {
  return cleanText(value);
}

function normalize(value = '') {
  return normalizeText(value);
}

function toAsciiDigits(value = '') {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return String(value)
    .replace(/[۰-۹]/g, d => String(fa.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(ar.indexOf(d)));
}

function stripLeadingEmoji(value = '') {
  return clean(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function parsePopularity(value = '') {
  const text = clean(value);
  const match = text.match(/\s+x\s+(\d+(?:\.\d+)?)\s*([kKmMgG])?\s*$/u);
  if (!match) return { text: undefined, count: undefined };
  const raw = `${match[1]}${match[2] || ''}`;
  const amount = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === 'g' ? 1_000_000_000 : 1;
  return {
    text: raw,
    count: Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined,
  };
}

function stripMetricSuffix(value = '') {
  return clean(value)
    .replace(/\s+x\s+\d+(?:\.\d+)?\s*[kKmMgG]?\s*$/u, '')
    .trim();
}

export function replyButtons(message) {
  const rows = message?.replyMarkup?.rows || [];
  const out = [];
  for (const row of rows) {
    for (const button of row?.buttons || []) {
      const text = clean(button?.text || '');
      if (text) out.push(text);
    }
  }
  return out;
}

function buttonsFromMessages(messages) {
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    for (const text of replyButtons(message)) {
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

export function describeMeloBotSurface(messages = [], {
  maxButtons = 18,
  maxTextChars = 320,
} = {}) {
  const buttons = buttonsFromMessages(messages)
    .slice(0, Math.max(1, Number(maxButtons || 18)))
    .map(text => clean(text).slice(0, 120));
  const text = (messages || [])
    .map(messageText)
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, Math.max(80, Number(maxTextChars || 320)));

  return JSON.stringify({ text, buttons });
}

function searchRefinementScore(rawText, query = '') {
  const raw = clean(rawText);
  if (!raw || isControl(raw) || parseAlbumButton(raw) || parseTrackButton(raw)) return -1;

  const isArtistPicker = /^[🗣🎤🎙]/u.test(raw);
  const comparable = normalize(
    isArtistPicker ? raw.replace(/^[🗣🎤🎙]+\s*/u, '') : raw
  );
  const target = normalize(query);
  if (!comparable || !target) return -1;

  const queryTokens = target.split(' ').filter(Boolean);
  const buttonTokens = comparable.split(' ').filter(Boolean);
  const buttonSet = new Set(buttonTokens);
  const overlap = queryTokens.filter(token => buttonSet.has(token)).length;
  if (!overlap) return -1;

  let score = overlap * 20;
  if (comparable === target) score += 80;
  else if (comparable.includes(target) || target.includes(comparable)) score += 35;

  // Prefer song/search refinements over an artist-picker fallback when both
  // are present, while still allowing the picker when it is the only route.
  if (!isArtistPicker) score += 8;
  score -= Math.max(0, buttonTokens.length - queryTokens.length);
  return score;
}

export function chooseMeloBotSearchRefinement(messages = [], query = '') {
  let best = null;
  let bestScore = -1;
  for (const rawText of buttonsFromMessages(messages)) {
    const score = searchRefinementScore(rawText, query);
    if (score > bestScore) {
      best = rawText;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

function isArtistPickerButton(rawText = '') {
  return /^[🗣🎤🎙]/u.test(clean(rawText));
}

function artistNameFromPicker(rawText = '') {
  return clean(rawText).replace(/^[🗣🎤🎙]+\s*/u, '').trim();
}

function mergeMessageSets(...groups) {
  const byId = new Map();
  const withoutId = [];
  for (const group of groups) {
    for (const message of group || []) {
      const id = Number(message?.id || 0);
      if (id > 0) byId.set(id, message);
      else withoutId.push(message);
    }
  }
  return [
    ...[...byId.values()].sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
    ...withoutId,
  ];
}

function maxMessageId(messages = []) {
  return (messages || []).reduce(
    (max, message) => Math.max(max, Number(message?.id || 0)),
    0
  );
}

async function collectLateMeloBotMessages(client, afterId, {
  timeoutMs = 3200,
  quietMs = 1100,
} = {}) {
  if (!(Number(afterId) > 0)) return [];
  const late = await collectNewMessages(
    client,
    config.melobotUsername,
    Number(afterId),
    { timeoutMs, quietMs }
  );
  return late.messages || [];
}

function isControl(text) {
  const value = clean(text);
  if (!value) return true;
  if (/^[⬅️🔙🏛️🏠🎙️🎤🗣️💿🎵🎶📀🎧]+$/u.test(value)) return true;
  return CONTROL_WORDS.some(word => value.includes(word));
}

function looksLikeAlbumButton(rawText) {
  const value = toAsciiDigits(stripLeadingEmoji(rawText));
  return /^.+?\s*\(\d+\)\s*$/u.test(value);
}

function looksLikeAlbumNavigationText(rawText = '') {
  const text = clean(rawText);
  if (!text || /دانلود/u.test(text)) return false;

  const normalized = normalize(text);
  if (/(?:^|\s)(?:آلبوم|البوم|albums?)(?:\s|$)/iu.test(normalized)) return true;
  if (/دیسکوگرافی|discography/iu.test(normalized)) return true;
  return /^[💿📀]\s*$/u.test(text);
}

export function parseTrackButton(rawText, fallbackArtist = '') {
  const original = clean(rawText);
  if (!original || isControl(original) || looksLikeAlbumButton(original)) return null;
  if (/^[🗣🎤🎙]/u.test(original)) return null;

  if (looksLikeAlbumNavigationText(original)) return null;

  const popularity = parsePopularity(original);
  let value = stripLeadingEmoji(original);
  value = stripMetricSuffix(value);

  const comma = value.indexOf(',');
  if (comma > 0) {
    const artist = clean(value.slice(0, comma));
    const title = stripMetricSuffix(value.slice(comma + 1));
    if (!artist || !title) return null;
    return {
      type: 'track',
      rawText: original,
      artist,
      title,
      sourcePopularityText: popularity.text,
      sourcePopularityCount: popularity.count,
      sourceStateVersion,
    };
  }

  const dashed = value.match(/^(.+?)\s+[–—-]\s+(.+)$/u);
  if (dashed) {
    const artist = clean(dashed[1]);
    const title = stripMetricSuffix(dashed[2]);
    if (artist && title) {
      return {
        type: 'track',
        rawText: original,
        artist,
        title,
        sourcePopularityText: popularity.text,
        sourcePopularityCount: popularity.count,
        sourceStateVersion,
      };
    }
  }

  if (fallbackArtist) {
    const title = stripMetricSuffix(stripLeadingEmoji(original));
    if (title) {
      return {
        type: 'track',
        rawText: original,
        artist: fallbackArtist,
        title,
        sourcePopularityText: popularity.text,
        sourcePopularityCount: popularity.count,
        sourceStateVersion,
      };
    }
  }

  return null;
}

export function parseAlbumButton(rawText) {
  const original = clean(rawText);
  if (!original || isControl(original)) return null;
  const value = toAsciiDigits(stripLeadingEmoji(original));
  const match = value.match(/^(.+?)\s*\((\d+)\)\s*$/u);
  if (!match) return null;
  return {
    type: 'album',
    rawText: original,
    title: clean(match[1]),
    trackCount: Number(match[2]),
    sourceStateVersion,
  };
}

function parseAlbumButtons(messages = []) {
  const albums = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(messages)) {
    const album = parseAlbumButton(rawText);
    if (!album) continue;
    const key = normalize(album.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    albums.push(album);
  }
  return albums;
}

function albumListingDeclaration(messages = []) {
  const text = toAsciiDigits(
    (messages || []).map(messageText).filter(Boolean).join('\n')
  );
  const normalized = normalize(text);
  const countMatch = normalized.match(/آلبوم\s*(?:های|ها)?\s*خواننده\s*(\d+)/u)
    || normalized.match(/album(?:s)?\s*(?:of\s*)?(?:artist|singer)?\s*(\d+)/iu);
  const declaredCount = countMatch ? Number(countMatch[1]) : null;
  const explicitEmpty = /(?:آلبوم|album).*(?:ندارد|وجود ندارد|no albums?)/iu.test(text)
    || declaredCount === 0;
  return { declaredCount, explicitEmpty };
}

function albumNextButton(messages = []) {
  return buttonsFromMessages(messages).find(rawText => {
    const text = clean(rawText);
    if (!text || parseAlbumButton(text)) return false;
    if (/قبلی|صفحه\s*قبل|previous|back/iu.test(text)) return false;
    return /بعدی|صفحه\s*بعد(?:ی)?|ادامه|next/iu.test(text)
      || /^(?:➡️|▶️|⏭️|›|»|→)+$/u.test(text);
  }) || null;
}

export function inspectMeloBotAlbumListing(messages = []) {
  const albums = parseAlbumButtons(messages);
  const declaration = albumListingDeclaration(messages);
  const nextButton = albumNextButton(messages);
  const confirmed = albums.length > 0
    || declaration.declaredCount !== null
    || declaration.explicitEmpty;
  const confirmedEmpty = albums.length === 0 && declaration.explicitEmpty;
  const complete = confirmedEmpty
    || (albums.length > 0 && (
      declaration.declaredCount !== null
        ? albums.length >= declaration.declaredCount
        : !nextButton
    ));

  return {
    albums,
    declaredCount: declaration.declaredCount,
    confirmed,
    confirmedEmpty,
    complete,
    nextButton,
  };
}

export function albumNavigationButton(messages = []) {
  return buttonsFromMessages(messages).find(rawText =>
    !parseAlbumButton(rawText) && looksLikeAlbumNavigationText(rawText)
  ) || null;
}

function findButton(messages, predicate) {
  return buttonsFromMessages(messages).find(predicate) || null;
}

function parseTracksFromMessages(messages, fallbackArtist = '') {
  const tracks = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(messages)) {
    const track = parseTrackButton(rawText, fallbackArtist);
    if (!track) continue;
    const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}|${track.rawText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }
  return tracks;
}

async function sendAndCollect(client, text, {
  timeoutMs = config.searchTimeoutMs,
  quietMs = 650,
  stopWhen,
  stopWhenBatch,
  onMessage,
} = {}) {
  const peer = config.melobotUsername;
  const afterId = await latestMessageId(client, peer);
  const stateVersion = ++sourceStateVersion;
  await client.sendMessage(peer, { message: text });
  const result = await collectNewMessages(client, peer, afterId, {
    timeoutMs,
    quietMs,
    stopWhen,
    stopWhenBatch,
    onMessage,
  });
  return { ...result, stateVersion };
}

function mergeAlbumPages(current = [], incoming = [], maxAlbums = 60) {
  const out = [];
  const seen = new Set();
  for (const album of [...current, ...incoming]) {
    const key = normalize(album?.title || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(album);
    if (out.length >= maxAlbums) break;
  }
  return out;
}

async function collectMeloBotAlbumPages(client, initial, {
  maxAlbums = 60,
  maxPages = 12,
} = {}) {
  let albums = mergeAlbumPages([], initial?.albums || [], maxAlbums);
  let declaredCount = initial?.declaredCount ?? null;
  let confirmedEmpty = Boolean(initial?.confirmedEmpty);
  let nextButton = initial?.nextButton || null;
  let pages = 1;
  let complete = Boolean(initial?.complete);
  const seenPages = new Set();

  while (!complete && nextButton && pages < maxPages && albums.length < maxAlbums) {
    const page = await sendAndCollect(client, nextButton, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 650,
    });
    const state = inspectMeloBotAlbumListing(page.messages);
    const fingerprint = [
      ...state.albums.map(album => normalize(album.title)),
      state.nextButton || '',
    ].join('|');

    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);

    albums = mergeAlbumPages(albums, state.albums, maxAlbums);
    if (declaredCount === null && state.declaredCount !== null) {
      declaredCount = state.declaredCount;
    }
    confirmedEmpty = confirmedEmpty || state.confirmedEmpty;
    nextButton = state.nextButton || null;
    pages += 1;

    complete = confirmedEmpty
      || (albums.length > 0 && (
        declaredCount !== null
          ? albums.length >= declaredCount
          : !nextButton
      ));

    if (!state.albums.length && !state.confirmedEmpty && !nextButton) break;
  }

  return {
    albums,
    declaredCount,
    confirmed: Boolean(albums.length || confirmedEmpty || declaredCount !== null),
    confirmedEmpty: Boolean(confirmedEmpty && albums.length === 0),
    complete,
    nextButton,
    pages,
  };
}

export async function searchMeloBot(client, query, {
  maxRefinements = 3,
} = {}) {
  const requested = clean(query);
  if (!requested) throw new Error('MeloBot search query is empty.');

  let command = requested;
  let fallbackArtist = '';
  const seenTransitions = new Set();
  const allMessages = [];

  for (let step = 0; step <= Math.max(0, Number(maxRefinements || 0)); step += 1) {
    if (!normalize(command)) break;

    const result = await sendAndCollect(client, command, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 650,
    });
    allMessages.push(...(result.messages || []));

    const tracks = parseTracksFromMessages(result.messages, fallbackArtist);
    if (tracks.length) return tracks;

    const surfaceKey = `${normalize(command)}|${describeMeloBotSurface(result.messages)}`;
    if (seenTransitions.has(surfaceKey)) break;
    seenTransitions.add(surfaceKey);

    const refinement = chooseMeloBotSearchRefinement(result.messages, requested);
    if (!refinement) break;

    if (isArtistPickerButton(refinement)) {
      fallbackArtist = artistNameFromPicker(refinement) || fallbackArtist;
    }
    command = refinement;
  }

  throw new Error(
    `MeloBot search returned no usable tracks. ${describeMeloBotSurface(allMessages)}`
  );
}

async function findArtistSeed(client, artist, preferredSeed = null) {
  let seed = preferredSeed;

  try {
    const results = await searchMeloBot(client, artist);
    const target = normalize(artist);
    seed = results.find(track => normalize(track.artist) === target)
      || results.find(track =>
        normalize(track.artist).includes(target) ||
        target.includes(normalize(track.artist))
      )
      || seed;
  } catch (err) {
    console.warn('[melobot artist seed]', artist, err.message);
  }

  if (!seed) throw new Error(`No usable MeloBot seed track found for artist: ${artist}`);
  return seed;
}

export async function openMeloBotArtistFresh(client, artist, preferredSeed = null) {
  const seed = await findArtistSeed(client, artist, preferredSeed);
  return openMeloBotArtist(client, seed);
}

async function resolveMeloBotTrackCandidate(client, candidate) {
  const query = [candidate?.artist, candidate?.title].filter(Boolean).join(' ')
    || candidate?.title
    || candidate?.rawText;

  if (!query) throw new Error('MeloBot track candidate is incomplete.');

  if (
    candidate?.rawText
    && Number(candidate.sourceStateVersion || -1) === sourceStateVersion
  ) {
    return candidate;
  }

  try {
    const results = await searchMeloBot(client, query);
    const artist = normalize(candidate?.artist || '');
    const title = normalize(candidate?.title || '');

    return results.find(track =>
      normalize(track.artist) === artist && normalize(track.title) === title
    ) || results.find(track =>
      title && normalize(track.title) === title
    ) || results[0] || candidate;
  } catch (err) {
    console.warn('[melobot resolve track]', err.message);
    return candidate;
  }
}

async function openTrackMenu(client, candidate) {
  const liveCandidate = await resolveMeloBotTrackCandidate(client, candidate);
  if (!liveCandidate?.rawText) throw new Error('MeloBot live track button was not found.');

  const selected = await sendAndCollect(client, liveCandidate.rawText, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 550,
    stopWhen: m => replyButtons(m).some(text =>
      text.includes('کیفیت عالی') || text.includes('کیفیت معمولی')
    ),
  });
  return selected.messages;
}

export async function downloadMeloBotTrack(client, candidate) {
  const menuMessages = await openTrackMenu(client, candidate);

  const highQualityButton = findButton(menuMessages, text =>
    text.includes('کیفیت عالی') && !text.includes('خرید اشتراک')
  );

  if (!highQualityButton) {
    const response = menuMessages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`MeloBot HQ button not found. ${response.slice(0, 350)}`);
  }

  const download = await sendAndCollect(client, highQualityButton, {
    timeoutMs: config.downloadTimeoutMs,
    quietMs: 600,
    stopWhen: isAudioMessage,
  });

  const audio = download.messages.find(isAudioMessage);
  if (!audio) {
    const response = download.messages.map(messageText).filter(Boolean).join('\n');
    if (/خرید اشتراک|premium|اشتراک/i.test(response)) {
      throw new Error('MeloBot Premium/HQ access was not recognized for the proxy account.');
    }
    throw new Error(`MeloBot did not deliver HQ audio. ${response.slice(0, 350)}`);
  }

  return {
    source: 'melobot',
    candidate,
    audioMessage: audio,
  };
}


export async function downloadMeloBotTrackQuality(client, candidate, quality = 'hq') {
  const menuMessages = await openTrackMenu(client, candidate);
  const wantsHigh = quality === 'hq';
  const button = findButton(menuMessages, text => {
    const value = clean(text);
    if (wantsHigh) return value.includes('کیفیت عالی') && !value.includes('خرید اشتراک');
    return value.includes('کیفیت معمولی') && !value.includes('دانلود همه');
  });

  if (!button) {
    throw new Error(`MeloBot ${quality} quality button not found.`);
  }

  const result = await sendAndCollect(client, button, {
    timeoutMs: config.downloadTimeoutMs,
    quietMs: 650,
    stopWhen: isAudioMessage,
  });

  const audio = result.messages.find(isAudioMessage);
  if (!audio) {
    const response = result.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`MeloBot did not deliver ${quality} audio. ${response.slice(0, 350)}`);
  }

  return { source: 'melobot', quality, candidate, audioMessage: audio };
}

function photoMessage(message) {
  return Boolean(message?.media?.photo);
}

async function openMoreMenu(client, candidate) {
  const menuMessages = await openTrackMenu(client, candidate);
  const moreButton = findButton(menuMessages, text => /بیشتر/u.test(clean(text)));
  if (!moreButton) throw new Error('MeloBot more button not found.');

  const more = await sendAndCollect(client, moreButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 600,
  });
  return more.messages;
}

export function sanitizeMeloBotLyricsText(raw = '', candidate = {}) {
  const artistNorm = normalize(candidate.artist || '');
  const titleNorm = normalize(candidate.title || '');

  const lines = String(raw || '')
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const kept = lines.filter(line => {
    const n = normalize(line);
    if (!n) return false;

    // Remove MeloBot branding/footer regardless of emoji or ID prefix.
    if (/@melobot\b/iu.test(line)) return false;
    if (/\bmelobot\b/iu.test(n)) return false;

    if (artistNorm && n === artistNorm) return false;
    if (titleNorm && n === titleNorm) return false;
    if (line.startsWith('#')) return false;
    if (/دانلود\s*آهنگ/u.test(line)) return false;

    return true;
  });

  return kept.join('\n').trim();
}

export async function getMeloBotLyrics(client, candidate) {
  const menuMessages = await openTrackMenu(client, candidate);
  const lyricsButton = findButton(menuMessages, text => /متن\s*آهنگ/u.test(clean(text)));
  if (!lyricsButton) return { available: false, text: '' };

  const result = await sendAndCollect(client, lyricsButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
  });

  const raw = result.messages.map(messageText).filter(Boolean).join('\n\n').trim();
  if (!raw) return { available: false, text: '' };

  const text = sanitizeMeloBotLyricsText(raw, candidate);
  return { available: Boolean(text), text, rawText: raw };
}

function parsePopularityValue(text = '') {
  const match = String(text).match(/(?:📥|download|دانلود)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*([kKmMgG])?/iu);
  if (!match) return {};
  const amount = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === 'g' ? 1_000_000_000 : 1;
  return {
    popularityText: `${match[1]}${match[2] || ''}`,
    popularityCount: Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined,
  };
}

function parseReleaseDate(text = '') {
  const candidates = String(text).split(/\n/).map(line => line.trim()).filter(Boolean);
  for (const line of candidates) {
    const stripped = line.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!/(?:19|20)\d{2}/.test(stripped)) continue;
    const time = Date.parse(stripped);
    if (!Number.isFinite(time)) continue;
    const d = new Date(time);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return { releaseDate: iso, releaseDateRaw: stripped };
  }
  return {};
}

export async function getMeloBotTrackMetadata(client, candidate) {
  const moreMessages = await openMoreMenu(client, candidate);
  const detailsButton = findButton(moreMessages, text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text)));
  if (!detailsButton) return { raw: '', ...parsePopularityValue(candidate.rawText || '') };

  const result = await sendAndCollect(client, detailsButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
  });
  const raw = result.messages.map(messageText).filter(Boolean).join('\n\n').trim();
  return {
    raw,
    ...parseReleaseDate(raw),
    ...parsePopularityValue(raw || candidate.rawText || ''),
  };
}

export async function getMeloBotCover(client, candidate) {
  const moreMessages = await openMoreMenu(client, candidate);
  const coverButton = findButton(moreMessages, text => /کاور/u.test(clean(text)));
  if (!coverButton) return null;

  const result = await sendAndCollect(client, coverButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
    stopWhen: photoMessage,
  });

  const photo = result.messages.find(photoMessage);
  return photo ? { source: 'melobot', photoMessage: photo } : null;
}

export async function enrichMeloBotTrack(client, candidate) {
  const liveCandidate = await resolveMeloBotTrackCandidate(client, candidate);
  if (!liveCandidate?.rawText) throw new Error('MeloBot live track button was not found.');

  const selected = await sendAndCollect(client, liveCandidate.rawText, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 550,
    stopWhen: message => replyButtons(message).some(text =>
      text.includes('کیفیت عالی') || text.includes('کیفیت معمولی')
    ),
  });

  const menuMessages = selected.messages;
  const menuButtons = buttonsFromMessages(menuMessages);
  const result = {
    candidate: liveCandidate,
    metadata: {
      raw: '',
      ...parsePopularityValue(liveCandidate.rawText || candidate?.rawText || ''),
    },
    lyrics: { available: false, text: '' },
    cover: null,
    capabilities: {
      hasHq: menuButtons.some(text =>
        clean(text).includes('کیفیت عالی') && !clean(text).includes('خرید اشتراک')
      ),
      hasNormal: menuButtons.some(text =>
        clean(text).includes('کیفیت معمولی') && !clean(text).includes('دانلود همه')
      ),
      hasLyrics: menuButtons.some(text => /متن\s*آهنگ/u.test(clean(text))),
      hasCover: false,
      hasMetadata: false,
      hasArtistPage: menuButtons.some(text =>
        /خواننده/u.test(clean(text)) && !/پیشنهاد/u.test(clean(text))
      ),
    },
    errors: [],
  };

  const lyricsButton = menuButtons.find(text => /متن\s*آهنگ/u.test(clean(text))) || null;
  if (lyricsButton) {
    try {
      const lyricsResult = await sendAndCollect(client, lyricsButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 650,
      });
      const raw = lyricsResult.messages.map(messageText).filter(Boolean).join('\n\n').trim();
      const text = sanitizeMeloBotLyricsText(raw, liveCandidate);
      result.lyrics = {
        available: Boolean(text),
        text,
        rawText: raw,
      };
    } catch (err) {
      result.errors.push(`lyrics: ${err.message}`);
    }
  }

  const moreButton = menuButtons.find(text => /بیشتر/u.test(clean(text))) || null;
  if (moreButton) {
    try {
      const more = await sendAndCollect(client, moreButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 550,
      });
      const moreButtons = buttonsFromMessages(more.messages);
      result.capabilities.hasCover = moreButtons.some(text => /کاور/u.test(clean(text)));
      result.capabilities.hasMetadata = moreButtons.some(text =>
        /بقیه\s*مشخصات|مشخصات/u.test(clean(text))
      );

      const detailsButton = moreButtons.find(text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text))) || null;
      if (detailsButton) {
        try {
          const details = await sendAndCollect(client, detailsButton, {
            timeoutMs: config.searchTimeoutMs,
            quietMs: 600,
          });
          const raw = details.messages.map(messageText).filter(Boolean).join('\n\n').trim();
          result.metadata = {
            raw,
            ...parseReleaseDate(raw),
            ...parsePopularityValue(raw || liveCandidate.rawText || candidate?.rawText || ''),
          };
        } catch (err) {
          result.errors.push(`metadata: ${err.message}`);
        }
      }

      const coverButton = moreButtons.find(text => /کاور/u.test(clean(text))) || null;
      if (coverButton) {
        try {
          const coverResult = await sendAndCollect(client, coverButton, {
            timeoutMs: config.searchTimeoutMs,
            quietMs: 600,
            stopWhen: photoMessage,
          });
          const photo = coverResult.messages.find(photoMessage);
          if (photo) result.cover = { source: 'melobot', photoMessage: photo };
        } catch (err) {
          result.errors.push(`cover: ${err.message}`);
        }
      }
    } catch (err) {
      result.errors.push(`more: ${err.message}`);
    }
  }

  return result;
}

export async function discoverMeloBotFeed(client, command, { contentOrigin = 'unknown' } = {}) {
  const result = await sendAndCollect(client, command, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
    stopWhen: message => replyButtons(message).some(text => Boolean(parseTrackButton(text))),
  });

  const tracks = parseTracksFromMessages(result.messages).map(track => ({
    ...track,
    source: 'melobot',
    contentOrigin,
  }));

  const artists = [...new Set(tracks.map(track => clean(track.artist)).filter(Boolean))];
  return { command, tracks, artists };
}

export async function inspectMeloBotTrack(client, candidate) {
  const menuMessages = await openTrackMenu(client, candidate);
  const menuButtons = buttonsFromMessages(menuMessages);

  const hasHq = menuButtons.some(text =>
    clean(text).includes('کیفیت عالی') && !clean(text).includes('خرید اشتراک')
  );
  const hasNormal = menuButtons.some(text =>
    clean(text).includes('کیفیت معمولی') && !clean(text).includes('دانلود همه')
  );
  const hasLyrics = menuButtons.some(text => /متن\s*آهنگ/u.test(clean(text)));
  const hasArtistPage = menuButtons.some(text =>
    /خواننده/u.test(clean(text)) && !/پیشنهاد/u.test(clean(text))
  );
  const moreButton = menuButtons.find(text => /بیشتر/u.test(clean(text))) || null;

  let hasCover = false;
  let hasMetadata = false;
  if (moreButton) {
    try {
      const more = await sendAndCollect(client, moreButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 550,
      });
      const moreButtons = buttonsFromMessages(more.messages);
      hasCover = moreButtons.some(text => /کاور/u.test(clean(text)));
      hasMetadata = moreButtons.some(text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text)));
    } catch (err) {
      console.warn('[melobot inspect more]', err.message);
    }
  }

  return {
    hasHq,
    hasNormal,
    hasLyrics,
    hasCover,
    hasMetadata,
    hasArtistPage,
  };
}

async function openMeloBotArtistBase(client, seedTrack) {
  const menuMessages = await openTrackMenu(client, seedTrack);
  const artistButton = findButton(menuMessages, text =>
    text.includes('خواننده') && !text.includes('پیشنهاد')
  );
  if (!artistButton) {
    console.warn(
      '[melobot artist menu surface]',
      seedTrack?.artist || 'unknown',
      describeMeloBotSurface(menuMessages)
    );
    throw new Error('MeloBot artist button not found.');
  }

  let artistPage = await sendAndCollect(client, artistButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
  });

  // Collaborative tracks can open an intermediate artist picker.
  const pickerButtons = buttonsFromMessages(artistPage.messages)
    .filter(text => /^[🗣🎤🎙]/u.test(clean(text)))
    .map(rawText => ({
      rawText,
      name: clean(rawText).replace(/^[🗣🎤🎙]+\s*/u, '').trim(),
    }))
    .filter(item => item.name && !/خواننده|پیشنهاد/u.test(item.name));

  let selectedArtist = seedTrack.artist;
  const relatedArtists = pickerButtons.map(item => item.name);

  if (pickerButtons.length) {
    const requested = normalize(seedTrack.artist);
    const requestedParts = requested.split(/\s*(?:&|\bx\b|,|feat\.?|ft\.?)\s*/iu).filter(Boolean);

    const chosen = pickerButtons.find(item => normalize(item.name) === requested)
      || pickerButtons.find(item => requestedParts.includes(normalize(item.name)))
      || pickerButtons.find(item => requested.includes(normalize(item.name)))
      || pickerButtons[0];

    selectedArtist = chosen.name;

    artistPage = await sendAndCollect(client, chosen.rawText, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 750,
    });
  }

  const allButtons = buttonsFromMessages(artistPage.messages);
  const recentTracks = parseTracksFromMessages(artistPage.messages, selectedArtist);
  const albumListing = inspectMeloBotAlbumListing(artistPage.messages);
  const albumButton = albumListing.confirmed
    ? null
    : albumNavigationButton(artistPage.messages);

  const orderButton = allButtons.find(text => /ترتیب/u.test(clean(text))) || null;
  const moreButton = allButtons.find(text => /بیشتر|more/iu.test(clean(text))) || null;
  const sourceAfterId = maxMessageId(artistPage.messages);
  const recentBulkHighButton = findButton(artistPage.messages, text =>
    /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
  );
  const recentBulkNormalButton = findButton(artistPage.messages, text =>
    /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
  );

  return {
    artist: selectedArtist,
    tracks: recentTracks,
    recentTracks,
    albumButton,
    albumList: albumListing.albums,
    albumListingConfirmed: albumListing.confirmed,
    albumListingConfirmedEmpty: albumListing.confirmedEmpty,
    albumDeclaredCount: albumListing.declaredCount,
    albumListingComplete: albumListing.complete,
    albumNextButton: albumListing.nextButton || null,
    orderButton,
    moreButton,
    sourceAfterId,
    sourceButtons: allButtons.slice(0, 30),
    sourceStateVersion: sourceStateVersion,
    recentBulkHighButton,
    recentBulkNormalButton,
    relatedArtists,
  };
}

export async function openMeloBotArtist(client, seedTrack) {
  const base = await openMeloBotArtistBase(client, seedTrack);
  let topTracks = [];
  let bulkHighButton = null;
  let bulkNormalButton = null;

  if (base.orderButton) {
    try {
      let ordered = await sendAndCollect(client, base.orderButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 650,
        stopWhen: message => {
          const buttons = replyButtons(message);
          const hasTracks = buttons.some(text => parseTrackButton(text, base.artist));
          const hasBulkHq = buttons.some(text =>
            /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
          );
          return hasTracks && hasBulkHq;
        },
      });

      if (!parseTracksFromMessages(ordered.messages, base.artist).length) {
        const popularityButton = findButton(ordered.messages, text =>
          /بازدید|محبوب|برتر|پر.?دانلود/u.test(clean(text))
        );
        if (popularityButton) {
          ordered = await sendAndCollect(client, popularityButton, {
            timeoutMs: config.searchTimeoutMs,
            quietMs: 650,
            stopWhen: message => replyButtons(message)
              .some(text => parseTrackButton(text, base.artist)),
          });
        }
      }

      topTracks = parseTracksFromMessages(ordered.messages, base.artist);
      bulkHighButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
      );
      bulkNormalButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
      );
    } catch (err) {
      console.warn('[melobot artist sort]', err.message);
    }
  }

  if (!topTracks.length) topTracks = base.recentTracks;

  return {
    ...base,
    tracks: topTracks,
    topTracks,
    bulkHighButton,
    bulkNormalButton,
  };
}

export async function prepareMeloBotBulkTopTracks(client, artist, preferredSeed = null) {
  const seed = await findArtistSeed(client, artist, preferredSeed);
  const context = await openMeloBotArtist(client, seed);
  if (!context.bulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found on the sorted artist page.');
  }
  return context;
}

export async function prepareMeloBotBulkRecentTracks(client, artist, preferredSeed = null) {
  const seed = await findArtistSeed(client, artist, preferredSeed);
  const context = await openMeloBotArtistBase(client, seed);
  if (!context.recentBulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found on the newest artist page.');
  }
  return context;
}

export async function openMeloBotAlbumContext(client, artist, album) {
  const page = await sendAndCollect(client, album.rawText, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
    stopWhen: message => {
      const buttons = replyButtons(message);
      return buttons.some(text => parseTrackButton(text, artist)) &&
        buttons.some(text => /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text)));
    },
  });

  const tracks = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(page.messages)) {
    const track = parseTrackButton(rawText, artist);
    if (!track) continue;
    const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }

  const bulkHighButton = findButton(page.messages, text =>
    /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
  );
  const bulkNormalButton = findButton(page.messages, text =>
    /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
  );

  if (!tracks.length) {
    const response = page.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`No tracks found in MeloBot album ${album.title}. ${response.slice(0, 350)}`);
  }

  return {
    artist,
    album,
    tracks,
    bulkHighButton,
    bulkNormalButton,
    sourceStateVersion: sourceStateVersion,
  };
}

export async function prepareMeloBotBulkAlbum(client, artist, albumTitle, preferredSeed = null) {
  const context = await openMeloBotAlbumByTitle(
    client,
    artist,
    albumTitle,
    preferredSeed
  );
  if (!context.bulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found on the album page.');
  }
  return context;
}

export async function downloadMeloBotBulkTracks(client, {
  button,
  label = 'bulk',
  expectedCount = 0,
  timeoutMs = null,
} = {}) {
  if (!button) throw new Error(`MeloBot ${label} bulk button not found.`);

  const download = await sendAndCollect(client, button, {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : Math.max(config.downloadTimeoutMs, 180000),
    quietMs: expectedCount > 20 ? 12000 : 8000,
    stopWhenBatch: expectedCount > 0
      ? messages => messages.filter(isAudioMessage).length >= expectedCount
      : undefined,
  });

  const audios = download.messages.filter(isAudioMessage).map(audioMeta);
  if (!audios.length) {
    const response = download.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`MeloBot ${label} bulk HQ did not deliver audio. ${response.slice(0, 350)}`);
  }

  return {
    source: 'melobot',
    audioItems: audios,
  };
}

export async function downloadMeloBotTopTracks(client, artistContext) {
  return downloadMeloBotBulkTracks(client, {
    button: artistContext.bulkHighButton,
    label: 'top tracks',
    expectedCount: artistContext.topTracks?.length || artistContext.tracks?.length || 0,
  });
}

export async function downloadMeloBotRecentTracks(client, artistContext) {
  return downloadMeloBotBulkTracks(client, {
    button: artistContext.recentBulkHighButton,
    label: 'recent tracks',
    expectedCount: artistContext.recentTracks?.length || artistContext.tracks?.length || 0,
  });
}

export async function downloadMeloBotAlbumTracks(client, albumContext) {
  return downloadMeloBotBulkTracks(client, {
    button: albumContext.bulkHighButton,
    label: `album ${albumContext.album?.title || ''}`,
    expectedCount: albumContext.tracks?.length || 0,
  });
}

function audioMeta(message) {
  const doc = message?.media?.document;
  const attrs = doc?.attributes || [];
  const audio = attrs.find(a => a?.className === 'DocumentAttributeAudio');
  return {
    message,
    title: clean(audio?.title || ''),
    performer: clean(audio?.performer || ''),
    duration: Number(audio?.duration || 0) || undefined,
  };
}

export function matchBulkAudioToTracks(tracks, audioItems) {
  const unused = audioItems.map((item, index) => ({ ...item, index }));
  const matches = [];
  const allowPositionalFallback = tracks.length === audioItems.length;

  for (const track of tracks) {
    let best = null;
    let bestScore = -1;
    const nt = normalize(track.title);
    const na = normalize(track.artist);

    for (const item of unused) {
      if (item.used) continue;
      const it = normalize(item.title);
      const ia = normalize(item.performer);
      let score = 0;
      if (nt && it === nt) score += 8;
      else if (nt && it && (it.includes(nt) || nt.includes(it))) score += 5;
      if (na && ia === na) score += 4;
      else if (na && ia && (ia.includes(na) || na.includes(ia))) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    // Avoid corrupting cache when a partial bulk response is missing a song.
    // Positional matching is used only when the source returned the full count.
    if (!best || bestScore < 5) {
      best = allowPositionalFallback
        ? (unused.find(item => !item.used) || null)
        : null;
    }
    if (!best) continue;

    best.used = true;
    matches.push({ track, audioItem: best });
  }

  return matches;
}

export function albumQueryMatches(query, artist, albumTitle) {
  const albumTokens = albumSpecificTitleTokens(query, artist);

  // "آلبوم + نام خواننده" means show the artist's albums, not a literal
  // album title called "آلبوم".
  if (!albumTokens.length) return hasAlbumIntent(query);

  const title = normalize(albumTitle);
  return albumTokens.every(token => title.includes(token));
}

function stripAlbumIntent(query = '') {
  return clean(query)
    .replace(
      /(^|\s)(?:albums?|آلبوم(?:[‌\s]?(?:ها|های))?|البوم(?:[‌\s]?(?:ها|های))?)(?=\s|$)/giu,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function artistPickerItems(messages = []) {
  return buttonsFromMessages(messages)
    .filter(text => /^[🗣🎤🎙]/u.test(clean(text)))
    .map(rawText => ({
      rawText,
      name: clean(rawText).replace(/^[🗣🎤🎙]+\s*/u, '').trim(),
    }))
    .filter(item => item.name && !/خواننده|پیشنهاد/u.test(item.name));
}

function chooseArtistPicker(items = [], requested = '') {
  const target = normalize(requested);
  return items.find(item => normalize(item.name) === target)
    || items.find(item => normalize(item.name).includes(target) || target.includes(normalize(item.name)))
    || items[0]
    || null;
}

async function openMeloBotAlbumListingDirect(client, artistQuery) {
  const first = await sendAndCollect(client, artistQuery, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 750,
  });

  let artist = artistQuery;
  let messages = first.messages;
  let listing = inspectMeloBotAlbumListing(messages);

  if (!listing.confirmed) {
    const picker = chooseArtistPicker(artistPickerItems(messages), artistQuery);
    if (picker) {
      artist = picker.name;
      const selected = await sendAndCollect(client, picker.rawText, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 750,
      });
      messages = selected.messages;
      listing = inspectMeloBotAlbumListing(messages);
    }
  }

  if (!listing.confirmed) {
    const navButton = albumNavigationButton(messages);
    if (navButton) {
      const page = await sendAndCollect(client, navButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 750,
      });
      messages = page.messages;
      listing = inspectMeloBotAlbumListing(messages);
    }
  }

  if (listing.confirmed) {
    return {
      artist,
      listing,
      seed: null,
      artistContext: null,
      route: 'direct_surface',
      sourceStateVersion: sourceStateVersion,
    };
  }

  // Search-only layouts may require one or more suggestion selections before
  // a real track exists. Use that live track to enter the artist page, while
  // preserving the album-page state returned by getInitialMeloBotAlbumListing.
  const seeds = await searchMeloBot(client, artistQuery, { maxRefinements: 3 });
  const target = normalize(artistQuery);
  const seed = seeds.find(track => normalize(track.artist) === target)
    || seeds.find(track =>
      normalize(track.artist).includes(target) || target.includes(normalize(track.artist))
    )
    || seeds[0]
    || null;

  if (!seed) {
    throw new Error(
      `MeloBot direct album route found no usable seed for: ${artistQuery}. `
      + describeMeloBotSurface(messages)
    );
  }

  const artistContext = await openMeloBotArtistBase(client, seed);
  const initial = await getInitialMeloBotAlbumListing(client, artistContext);
  return {
    artist: artistContext.artist,
    listing: initial.listing,
    seed,
    artistContext,
    route: `direct_seed:${initial.route}`,
    sourceStateVersion: sourceStateVersion,
  };
}

export async function discoverMeloBotAlbumsByArtistQuery(client, query, {
  maxAlbums = 12,
} = {}) {
  const artistQuery = stripAlbumIntent(query);
  if (!artistQuery) return { artist: '', albums: [] };

  const first = await sendAndCollect(client, artistQuery, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 750,
  });

  let artist = artistQuery;
  let contextMessages = first.messages;
  let listing = inspectMeloBotAlbumListing(contextMessages);

  if (!listing.confirmed) {
    const picker = chooseArtistPicker(artistPickerItems(first.messages), artistQuery);
    if (picker) {
      artist = picker.name;
      const selected = await sendAndCollect(client, picker.rawText, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 750,
      });
      contextMessages = selected.messages;
      listing = inspectMeloBotAlbumListing(contextMessages);
    }
  }

  if (listing.confirmed) {
    const resolved = listing.complete || !listing.nextButton
      ? listing
      : await collectMeloBotAlbumPages(client, listing, { maxAlbums });
    return {
      artist,
      albums: resolved.albums,
      complete: resolved.complete,
      confirmedEmpty: resolved.confirmedEmpty,
      sourceStateVersion,
      sourceStateSinglePage: !(resolved.pages > 1),
    };
  }

  const navButton = albumNavigationButton(contextMessages);
  if (navButton) {
    const page = await sendAndCollect(client, navButton, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 750,
    });
    listing = inspectMeloBotAlbumListing(page.messages);
    if (listing.confirmed) {
      const resolved = listing.complete || !listing.nextButton
        ? listing
        : await collectMeloBotAlbumPages(client, listing, { maxAlbums });
      return {
        artist,
        albums: resolved.albums,
        complete: resolved.complete,
        confirmedEmpty: resolved.confirmedEmpty,
        sourceStateVersion,
        sourceStateSinglePage: !(resolved.pages > 1),
      };
    }
  }

  // Some source flows are multi-step search pickers rather than direct track
  // rows. Resolve them with the same bounded state-machine used everywhere
  // else, then enter the artist page from a real live track.
  let seedTracks = parseTracksFromMessages(first.messages);
  if (!seedTracks.length) {
    try {
      seedTracks = await searchMeloBot(client, artistQuery, { maxRefinements: 3 });
    } catch (err) {
      console.warn(
        '[melobot album seed search]',
        artistQuery,
        err.message,
        describeMeloBotSurface(first.messages)
      );
    }
  }

  const target = normalize(artistQuery);
  const seed = seedTracks.find(track => normalize(track.artist) === target)
    || seedTracks.find(track =>
      normalize(track.artist).includes(target) || target.includes(normalize(track.artist))
    )
    || seedTracks[0]
    || null;

  if (seed) {
    const artistContext = await openMeloBotArtistBase(client, seed);
    const resolved = await resolveMeloBotAlbums(
      client,
      artistContext,
      { allowEmpty: true, maxAlbums }
    );
    return {
      artist: artistContext.artist,
      albums: resolved.albums,
      complete: resolved.complete,
      confirmedEmpty: resolved.confirmedEmpty,
      seed,
      artistContext,
      declaredCount: resolved.declaredCount ?? null,
      confirmed: resolved.confirmed,
      sourceStateVersion: resolved.sourceStateVersion,
      sourceStateSinglePage: resolved.sourceStateSinglePage,
    };
  }

  throw new Error(
    `MeloBot could not resolve an album listing for: ${artistQuery}. `
    + describeMeloBotSurface(contextMessages || first.messages)
  );
}

export async function discoverMeloBotAlbumsForQuery(client, query, seedTracks = [], {
  maxArtists = 2,
  maxAlbums = 4,
} = {}) {
  const queryNorm = normalize(query);
  const byArtist = new Map();

  for (const track of seedTracks || []) {
    if (!track?.artist || !track?.rawText) continue;
    const key = normalize(track.artist);
    if (!key || byArtist.has(key)) continue;
    byArtist.set(key, track);
  }

  const candidates = [...byArtist.entries()]
    .sort((a, b) => {
      const aInQuery = queryNorm.includes(a[0]) ? 1 : 0;
      const bInQuery = queryNorm.includes(b[0]) ? 1 : 0;
      return bInQuery - aInQuery;
    })
    .slice(0, Math.max(1, Number(maxArtists || 2)));

  const albums = [];
  const seen = new Set();

  for (const [, seed] of candidates) {
    try {
      const artistContext = await openMeloBotArtistBase(client, seed);
      const artistAlbums = await listMeloBotAlbums(client, artistContext);
      for (const album of artistAlbums) {
        if (!albumQueryMatches(query, artistContext.artist, album.title)) continue;
        const key = `${normalize(artistContext.artist)}|${normalize(album.title)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        albums.push({
          ...album,
          artist: artistContext.artist,
          source: 'melobot',
        });
        if (albums.length >= Math.max(1, Number(maxAlbums || 4))) return albums;
      }
    } catch (err) {
      console.warn('[melobot album query]', seed.artist, err.message);
    }
  }

  return albums;
}

function embeddedMeloBotAlbumListing(artistContext) {
  if (!artistContext?.albumListingConfirmed) return null;

  const albums = Array.isArray(artistContext.albumList)
    ? artistContext.albumList
    : [];
  const declaredCount = artistContext.albumDeclaredCount ?? null;
  const confirmedEmpty = Boolean(artistContext.albumListingConfirmedEmpty);
  const nextButton = artistContext.albumNextButton || null;
  const complete = confirmedEmpty
    || (albums.length > 0 && (
      declaredCount !== null
        ? albums.length >= declaredCount
        : !nextButton
    ));

  return {
    albums,
    confirmed: true,
    confirmedEmpty,
    declaredCount,
    complete,
    nextButton,
  };
}

async function getInitialMeloBotAlbumListing(client, artistContext) {
  const embedded = embeddedMeloBotAlbumListing(artistContext);
  if (embedded) {
    return { listing: embedded, route: 'embedded' };
  }

  const albumControl = clean(artistContext?.albumButton || '');
  if (albumControl) {
    const page = await sendAndCollect(client, albumControl, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 750,
    });
    const listing = inspectMeloBotAlbumListing(page.messages);
    if (listing.confirmed) {
      return { listing, route: 'artist_album_button' };
    }
    console.warn(
      '[melobot album button surface]',
      artistContext?.artist || 'unknown',
      describeMeloBotSurface(page.messages)
    );
  }

  const probed = await probeMeloBotAlbumSurface(client, artistContext);
  if (probed.listing?.confirmed) {
    return { listing: probed.listing, route: probed.route };
  }

  throw new Error(
    `MeloBot album listing is not available or was not confirmed (route=${probed.route}).`
  );
}

async function probeMeloBotAlbumSurface(client, artistContext) {
  const artist = artistContext?.artist || 'unknown';
  let messages = [];
  let listing = inspectMeloBotAlbumListing(messages);

  // MeloBot sometimes emits a second artist-page message after the first
  // keyboard has already gone quiet. Because source access is serialized,
  // waiting for these late messages cannot consume another user's response.
  if (Number(artistContext?.sourceAfterId || 0) > 0) {
    const late = await collectLateMeloBotMessages(
      client,
      Number(artistContext.sourceAfterId),
      { timeoutMs: 3600, quietMs: 500 }
    );
    messages = mergeMessageSets(messages, late);
    listing = inspectMeloBotAlbumListing(messages);

    if (listing.confirmed) return { listing, messages, route: 'late_artist_page' };

    const lateNav = albumNavigationButton(messages);
    if (lateNav) {
      const page = await sendAndCollect(client, lateNav, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 750,
      });
      const pageListing = inspectMeloBotAlbumListing(page.messages);
      return { listing: pageListing, messages: page.messages, route: 'late_album_button' };
    }
  }

  // A few MeloBot artist layouts place secondary navigation under "more".
  const moreButton = clean(artistContext?.moreButton || '');
  if (moreButton) {
    const more = await sendAndCollect(client, moreButton, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 750,
    });
    messages = mergeMessageSets(messages, more.messages);
    listing = inspectMeloBotAlbumListing(more.messages);
    if (listing.confirmed) return { listing, messages: more.messages, route: 'artist_more_listing' };

    const navButton = albumNavigationButton(more.messages);
    if (navButton) {
      const page = await sendAndCollect(client, navButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 750,
      });
      const pageListing = inspectMeloBotAlbumListing(page.messages);
      return { listing: pageListing, messages: page.messages, route: 'artist_more_album_button' };
    }
  }

  console.warn(
    '[melobot album surface]',
    artist,
    describeMeloBotSurface(messages),
    JSON.stringify({ sourceButtons: artistContext?.sourceButtons || [] })
  );
  return { listing, messages, route: 'not_found' };
}

export async function resolveMeloBotAlbums(
  client,
  artistContext,
  { allowEmpty = false, maxAlbums = 60 } = {}
) {
  const initial = await getInitialMeloBotAlbumListing(client, artistContext);
  const listing = initial.listing;

  const resolved = listing.complete || !listing.nextButton
    ? listing
    : await collectMeloBotAlbumPages(client, listing, { maxAlbums });

  if (!resolved.albums.length && !allowEmpty) {
    throw new Error(
      resolved.confirmedEmpty
        ? 'MeloBot confirmed this artist has no albums.'
        : 'MeloBot album listing returned no usable albums.'
    );
  }

  return {
    ...resolved,
    source: resolved.pages > 1 ? `${initial.route}_paged` : initial.route,
    sourceStateVersion: sourceStateVersion,
    sourceStateSinglePage: !(resolved.pages > 1),
  };
}

export async function resolveMeloBotArtistAlbums(
  client,
  artist,
  preferredSeed = null,
  { allowEmpty = true, maxAlbums = 60 } = {}
) {
  let primaryError = null;

  try {
    const seed = await findArtistSeed(client, artist, preferredSeed);
    const artistContext = await openMeloBotArtistBase(client, seed);

    // MeloBot uses a stateful reply keyboard. Resolve albums immediately from
    // the base artist page before sorting/top-track navigation changes that state.
    const resolved = await resolveMeloBotAlbums(
      client,
      artistContext,
      { allowEmpty, maxAlbums }
    );

    return {
      artist: artistContext.artist,
      seed,
      artistContext,
      ...resolved,
    };
  } catch (err) {
    primaryError = err;
    console.warn('[melobot album primary route]', artist, err.message);
  }

  try {
    const direct = await discoverMeloBotAlbumsByArtistQuery(
      client,
      `album ${artist}`,
      { maxAlbums }
    );
    if (!direct.albums?.length && !direct.confirmedEmpty && !allowEmpty) {
      throw new Error('Direct album route returned no usable albums.');
    }
    return {
      artist: direct.artist || artist,
      seed: direct.seed || preferredSeed || null,
      artistContext: direct.artistContext || null,
      albums: direct.albums || [],
      complete: Boolean(direct.complete),
      confirmedEmpty: Boolean(direct.confirmedEmpty),
      confirmed: Boolean(direct.confirmed || direct.albums?.length || direct.confirmedEmpty),
      declaredCount: direct.declaredCount ?? null,
      source: 'direct_fallback',
      sourceStateVersion: direct.sourceStateVersion ?? sourceStateVersion,
      sourceStateSinglePage: direct.sourceStateSinglePage !== false,
    };
  } catch (directError) {
    throw new Error(
      `MeloBot album resolution failed. primary=${primaryError?.message || 'unknown'}; direct=${directError.message}`
    );
  }
}

export async function openMeloBotAlbumByTitle(
  client,
  artist,
  albumTitle,
  preferredSeed = null,
  { maxPages = 12 } = {}
) {
  let seed = null;
  let resolvedArtist = artist;
  let state;

  try {
    seed = await findArtistSeed(client, artist, preferredSeed);
    const artistContext = await openMeloBotArtistBase(client, seed);
    resolvedArtist = artistContext.artist;
    const initial = await getInitialMeloBotAlbumListing(client, artistContext);
    state = initial.listing;
  } catch (seedRouteError) {
    console.warn('[melobot album open primary]', artist, seedRouteError.message);
    const direct = await openMeloBotAlbumListingDirect(client, artist);
    resolvedArtist = direct.artist || artist;
    state = direct.listing;
    seed = direct.seed || preferredSeed || null;
  }

  const targetTitle = normalize(albumTitle);
  const seenPages = new Set();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const target = (state?.albums || []).find(album =>
      normalize(album.title) === targetTitle
    );
    if (target) {
      const context = await openMeloBotAlbumContext(
        client,
        resolvedArtist,
        target
      );
      return { ...context, seed };
    }

    if (!state?.nextButton) break;

    const page = await sendAndCollect(client, state.nextButton, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 750,
    });
    const nextState = inspectMeloBotAlbumListing(page.messages);
    const fingerprint = [
      ...nextState.albums.map(album => normalize(album.title)),
      nextState.nextButton || '',
    ].join('|');
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    state = nextState;
  }

  throw new Error(`MeloBot album was not found: ${albumTitle}`);
}

export async function listMeloBotAlbums(client, artistContext, { allowEmpty = false } = {}) {
  const resolved = await resolveMeloBotAlbums(client, artistContext, { allowEmpty });
  console.log(
    `[melobot] albums for ${artistContext.artist}: ${resolved.albums.length}`
    + (resolved.complete ? '' : ' (partial)')
  );
  return resolved.albums;
}

export async function openMeloBotAlbum(client, artist, album) {
  const context = await openMeloBotAlbumContext(client, artist, album);
  console.log(`[melobot] album ${album.title}: ${context.tracks.length} tracks`);
  return context.tracks;
}

async function openMeloBotDailyPlaylists(client) {
  const index = await sendAndCollect(client, '/playlists', {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 650,
  });

  const dailyButton = findButton(index.messages, text =>
    /پلی\s*لیست.*روزانه|پلیلیست.*روزانه/u.test(clean(text))
  );
  if (!dailyButton) throw new Error('MeloBot daily playlists button was not found.');

  return sendAndCollect(client, dailyButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 700,
  });
}

export async function listCuratedMeloBotPlaylists(client, { maxPlaylists = 5 } = {}) {
  const page = await openMeloBotDailyPlaylists(client);
  const buttons = buttonsFromMessages(page.messages);
  const out = [];
  const seen = new Set();

  for (const rule of CURATED_PLAYLISTS) {
    const rawText = buttons.find(text => rule.pattern.test(clean(text)));
    if (!rawText) continue;
    const key = rule.key;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: rule.label,
      title: clean(rawText),
      rawText,
      source: 'melobot',
    });
    if (out.length >= Math.max(1, Number(maxPlaylists || 5))) break;
  }

  return out;
}

export async function openMeloBotCuratedPlaylist(client, playlist) {
  if (!playlist?.key) throw new Error('Curated playlist key is missing.');
  const rule = curatedPlaylistByKey(playlist.key);
  if (!rule) throw new Error(`Unknown curated playlist: ${playlist.key}`);

  const page = await openMeloBotDailyPlaylists(client);
  const liveButton = buttonsFromMessages(page.messages).find(text => rule.pattern.test(clean(text)));
  if (!liveButton) throw new Error(`MeloBot playlist is not available: ${playlist.label || playlist.key}`);

  const result = await sendAndCollect(client, liveButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 2300,
    stopWhen: message => replyButtons(message).some(text => Boolean(parseTrackButton(text))),
  });

  const tracks = parseTracksFromMessages(result.messages).map(track => ({
    ...track,
    source: 'melobot',
  }));

  return {
    playlist: {
      ...playlist,
      label: rule.label,
      title: clean(liveButton),
      rawText: liveButton,
    },
    tracks,
  };
}

export async function discoverMeloBotPlaylists(client, { maxPlaylists = 5 } = {}) {
  const playlists = await listCuratedMeloBotPlaylists(client, { maxPlaylists });
  const entries = [];
  const tracks = [];
  const artists = [];
  const seenTracks = new Set();
  const seenArtists = new Set();

  for (const playlist of playlists) {
    try {
      const opened = await openMeloBotCuratedPlaylist(client, playlist);
      entries.push({ playlist: opened.playlist, tracks: opened.tracks });

      for (const track of opened.tracks) {
        const key = `${normalize(track.artist)}|${normalize(track.title)}`;
        if (!seenTracks.has(key)) {
          seenTracks.add(key);
          tracks.push(track);
        }

        const artistKey = normalize(track.artist);
        if (artistKey && !seenArtists.has(artistKey)) {
          seenArtists.add(artistKey);
          artists.push(track.artist);
        }
      }
    } catch (err) {
      console.warn('[melobot playlist discovery]', playlist.label, err.message);
    }
  }

  return {
    playlists,
    entries,
    tracks,
    artists,
  };
}

export async function discoverMeloBotHome(client, { maxSections = 3 } = {}) {
  // Bootstrap only through buttons that actually exist on MeloBot's live keyboard.
  // Never invent a button label such as "💿".
  const openHome = async () => {
    let page = await sendAndCollect(client, '/start', {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 650,
    });

    const homeButton = findButton(page.messages, text => /صفحه\s*اصلی/u.test(clean(text)));
    if (homeButton) {
      try {
        page = await sendAndCollect(client, homeButton, {
          timeoutMs: config.searchTimeoutMs,
          quietMs: 650,
        });
      } catch {}
    }
    return page;
  };

  const home = await openHome();
  const homeButtons = buttonsFromMessages(home.messages);

  const sectionButtons = homeButtons.filter(raw => {
    const text = clean(raw);
    if (!text || isControl(text)) return false;
    if (parseTrackButton(text) || parseAlbumButton(text)) return false;
    // Buttons shown on MeloBot home commonly represent playlists/categories.
    return true;
  }).slice(0, Math.max(0, maxSections));

  const tracks = [];
  const artists = [];
  const seenTracks = new Set();
  const seenArtists = new Set();

  const absorb = messages => {
    for (const track of parseTracksFromMessages(messages)) {
      const key = `${normalize(track.artist)}|${normalize(track.title)}|${normalize(track.rawText)}`;
      if (seenTracks.has(key)) continue;
      seenTracks.add(key);
      tracks.push(track);
      const artistKey = normalize(track.artist);
      if (artistKey && !seenArtists.has(artistKey)) {
        seenArtists.add(artistKey);
        artists.push(track.artist);
      }
    }
    for (const raw of buttonsFromMessages(messages)) {
      const text = clean(raw);
      const match = text.match(/^[🗣🎤🎙]+\s*(.+)$/u);
      if (!match) continue;
      const name = clean(match[1]);
      const key = normalize(name);
      if (!key || seenArtists.has(key) || /خواننده|پیشنهاد/u.test(name)) continue;
      seenArtists.add(key);
      artists.push(name);
    }
  };

  absorb(home.messages);

  for (const sectionButton of sectionButtons) {
    try {
      // Reset to a known keyboard state before every click.
      await openHome();
      const section = await sendAndCollect(client, sectionButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 650,
        stopWhen: message => replyButtons(message).some(text => Boolean(parseTrackButton(text))),
      });
      absorb(section.messages);
    } catch (err) {
      console.warn('[melobot bootstrap section]', sectionButton, err.message);
    }
  }

  return { tracks, artists, sections: sectionButtons };
}
