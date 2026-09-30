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
  getTelegramInboxSequence,
  isAudioMessage,
  latestMessageId,
  messageText,
} from '../mtproto.js';

// State tokens may leak into short-lived catalog/session JSON. Seed the
// counter from wall-clock time so a process restart cannot accidentally reuse
// an old token and treat a stale MeloBot reply-keyboard row as still clickable.
let sourceStateVersion = Date.now() * 1000 + Math.floor(Math.random() * 1000);

// The MTProto account is a single stateful MeloBot conversation shared by all
// Navazon users. Keep the currently-open Track menu only in process memory.
// This is deliberately NOT persisted: reply-keyboard buttons/raw text are
// ephemeral source state, while artist/title are durable catalog identity.
let liveTrackSurface = null;
let liveMoreSurface = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ALBUM_PRIMARY_CIRCUIT_MS = 10 * 60 * 1000;
const ARTIST_NAV_TIMEOUT_MS = Math.min(config.searchTimeoutMs, 6000);
const ARTIST_SORT_TIMEOUT_MS = Math.min(config.searchTimeoutMs, 3500);
const EXACT_SEARCH_PROBE_TIMEOUT_MS = Math.min(config.searchTimeoutMs, 3500);
const albumPrimaryCircuit = new Map();

export function getMeloBotStateVersion() {
  return sourceStateVersion;
}

function albumCircuitKey(artist = '') {
  return normalize(artist);
}

function albumPrimaryCircuitRemainingMs(artist = '') {
  const key = albumCircuitKey(artist);
  const until = Number(albumPrimaryCircuit.get(key) || 0);
  const remaining = until - Date.now();
  if (remaining <= 0) {
    albumPrimaryCircuit.delete(key);
    return 0;
  }
  return remaining;
}

function markAlbumPrimaryFailure(artist = '') {
  const key = albumCircuitKey(artist);
  if (!key) return;
  albumPrimaryCircuit.set(key, Date.now() + ALBUM_PRIMARY_CIRCUIT_MS);
}

function clearAlbumPrimaryFailure(artist = '') {
  const key = albumCircuitKey(artist);
  if (key) albumPrimaryCircuit.delete(key);
}

export function getMeloBotAlbumPrimaryCircuitRemainingMs(artist = '') {
  return albumPrimaryCircuitRemainingMs(artist);
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

function sourceBudget(timeoutMs, fallbackMs = config.searchTimeoutMs) {
  const total = Math.max(800, Number(timeoutMs || fallbackMs));
  const deadline = Date.now() + total;
  // Never silently grant another 450ms after the budget has expired. Callers
  // that forget to check expired() get a near-immediate final probe instead.
  const remaining = () => Math.max(25, deadline - Date.now());
  remaining.expired = () => Date.now() >= deadline;
  return remaining;
}

function meloError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, details);
  return err;
}

function trackLabel(candidate = {}) {
  return [candidate.artist, candidate.title].filter(Boolean).join(' — ')
    || candidate.rawText
    || 'unknown track';
}

function sameTrackIdentity(left = {}, right = {}) {
  const leftTitle = titleIdentity(left?.title || '');
  const rightTitle = titleIdentity(right?.title || '');
  if (!leftTitle || leftTitle !== rightTitle) return false;

  const leftArtist = left?.artist || '';
  const rightArtist = right?.artist || '';
  if (leftArtist && rightArtist && !artistIdentityCompatible(leftArtist, rightArtist)) {
    return false;
  }
  return true;
}

function rememberLiveTrackSurface(client, candidate = {}, messages = [], version = sourceStateVersion) {
  if (!client || !candidate?.title || !hasTrackActionMenu(messages)) {
    liveTrackSurface = null;
    return null;
  }
  liveMoreSurface = null;
  liveTrackSurface = {
    client,
    candidate: { ...candidate },
    messages: [...messages],
    version: Number(version || sourceStateVersion),
  };
  return liveTrackSurface;
}

function rememberLiveMoreSurface(
  client,
  candidate = {},
  messages = [],
  version = sourceStateVersion,
  trackMenuMessages = []
) {
  if (!client || !candidate?.title || !(messages || []).some(isMoreMenuSurface)) {
    liveMoreSurface = null;
    return null;
  }
  liveTrackSurface = null;
  liveMoreSurface = {
    client,
    candidate: { ...candidate },
    messages: [...messages],
    trackMenuMessages: [...(trackMenuMessages || [])],
    version: Number(version || sourceStateVersion),
  };
  return liveMoreSurface;
}

function currentLiveTrackSurface(client, candidate = {}) {
  if (!liveTrackSurface || liveTrackSurface.client !== client) return null;
  if (Number(liveTrackSurface.version) !== Number(sourceStateVersion)) return null;
  return sameTrackIdentity(candidate, liveTrackSurface.candidate)
    ? liveTrackSurface
    : null;
}

function currentLiveMoreSurface(client, candidate = {}) {
  if (!liveMoreSurface || liveMoreSurface.client !== client) return null;
  if (Number(liveMoreSurface.version) !== Number(sourceStateVersion)) return null;
  return sameTrackIdentity(candidate, liveMoreSurface.candidate)
    ? liveMoreSurface
    : null;
}

function hasTrackActionMenu(messages = []) {
  return buttonsFromMessages(messages).some(text => {
    const value = clean(text);
    return (
      (value.includes('کیفیت عالی') || value.includes('کیفیت معمولی'))
      && !value.includes('دانلود همه')
    );
  });
}

function normalize(value = '') {
  return normalizeText(value);
}

function artistIdentityParts(value = '') {
  return clean(value)
    .split(/\s*(?:&|\bx\b|,|feat\.?|ft\.?|featuring)\s*/iu)
    .map(normalize)
    .filter(Boolean);
}

export function findArtistButtonFor(messages = [], artist = '') {
  const target = normalize(artist);
  const pickers = artistPickerItems(messages);
  const exact = pickers.find(item => normalize(item.name) === target);
  if (exact) return exact.rawText;

  const parts = artistIdentityParts(artist);
  // A collaboration page must never silently choose one member just because
  // the source exposed individual artist buttons. Exact composite credits or
  // the generic legacy "خواننده" transition are safe; otherwise fail closed
  // and let the caller surface an explicit choice later.
  if (parts.length <= 1) {
    const compatible = pickers.find(item => {
      const name = normalize(item.name);
      if (!name) return false;
      const part = parts[0] || '';
      if (part === name) return true;
      const partTokens = part.split(' ').filter(Boolean);
      const nameTokens = name.split(' ').filter(Boolean);
      if (partTokens.length <= 1 || nameTokens.length <= 1) return false;
      return part.includes(name) || name.includes(part);
    });
    if (compatible) return compatible.rawText;
  }

  const legacy = findButton(messages, text =>
    /خواننده/u.test(clean(text)) && !/پیشنهاد/u.test(clean(text))
  );
  if (legacy) return legacy;

  return !target && pickers.length === 1 ? pickers[0].rawText : null;
}

function titleIdentity(value = '') {
  return normalize(value)
    .replace(/\s*\((?:feat\.?|ft\.?|featuring)\s+[^)]+\)\s*$/iu, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '')
    .trim();
}

function artistIdentityCompatible(requested = '', actual = '') {
  const a = normalize(requested);
  const b = normalize(actual);
  if (!a || !b) return false;
  if (a === b) return true;

  // Split the original credit before normalization. normalizeText deliberately
  // removes punctuation such as "&", so splitting the normalized value loses
  // collaboration boundaries and makes reordered credits impossible to match.
  const requestedParts = artistIdentityParts(requested);
  const actualParts = artistIdentityParts(actual);
  const partMatches = (left, right) => {
    if (left === right) return true;
    const leftTokens = left.split(' ').filter(Boolean);
    const rightTokens = right.split(' ').filter(Boolean);
    // Do not conflate short stage names/surnames with longer unrelated
    // identities (Farhad vs Farhad Ravanbakhsh, Bahram vs Reza Bahram).
    if (leftTokens.length <= 1 || rightTokens.length <= 1) return false;
    return left.includes(right) || right.includes(left);
  };

  // A requested collaboration must not silently collapse to one of its
  // artists. This was the source of false resolutions for tracks such as
  // "Ali Sorena & Bahram". A single requested primary artist may still match
  // a source credit that includes extra featured artists.
  if (requestedParts.length > 1) {
    return requestedParts.every(left =>
      actualParts.some(right => partMatches(left, right))
    );
  }

  return requestedParts.some(left =>
    actualParts.some(right => partMatches(left, right))
  );
}

function describeTargetMessage(message = {}) {
  const doc = message?.media?.document;
  const photo = message?.media?.photo;
  return {
    id: Number(message?.id || 0),
    chatId: String(message?.__navazonChatId || ''),
    senderId: String(message?.senderId || ''),
    edited: Boolean(message?.__navazonEdited),
    media: doc ? 'document' : photo ? 'photo' : message?.media ? 'other' : 'none',
    mime: doc?.mimeType || '',
    audioAttr: Boolean((doc?.attributes || []).some(a => a?.className === 'DocumentAttributeAudio')),
  };
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

function stripFeedRankPrefix(value = '') {
  return clean(value)
    .replace(/^#?\s*[۰-۹٠-٩0-9]+\s+[🎵🎶🎧]\s*/u, '')
    .trim();
}

function metricSuffixMatch(value = '') {
  return clean(value).match(
    /\s+x\s+(<\s*)?(\d+(?:\.\d+)?)\s*([kKmMgG])?(\s*[.…]+)?\s*$/u
  );
}

function parsePopularity(value = '') {
  const match = metricSuffixMatch(value);
  if (!match) return { text: undefined, count: undefined };

  const isUpperBound = Boolean(match[1]);
  const isTruncated = Boolean(match[4]);
  const raw = `${isUpperBound ? '<' : ''}${match[2]}${match[3] || ''}${isTruncated ? '…' : ''}`;
  if (isUpperBound || isTruncated) {
    return { text: raw, count: undefined };
  }

  const amount = Number(match[2]);
  const unit = (match[3] || '').toLowerCase();
  const multiplier = unit === 'k'
    ? 1_000
    : unit === 'm'
      ? 1_000_000
      : unit === 'g'
        ? 1_000_000_000
        : 1;
  return {
    text: raw,
    count: Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined,
  };
}

function stripMetricSuffix(value = '') {
  const text = clean(value);
  const match = metricSuffixMatch(text);
  if (!match) return text;
  return clean(text.slice(0, match.index));
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

  const normalized = normalize(value);
  if (
    /^(?:پربازدیدترین(?: ها)?|محبوب ترین(?: ها)?|برترین(?: ها)?|پر.?دانلودترین(?: ها)?|جدیدترین(?: ها)?|نمایش به ترتیب(?: .*)?|ترتیب بر اساس(?: .*)?)$/u
      .test(normalized)
  ) {
    return true;
  }

  return CONTROL_WORDS.some(word => value.includes(word));
}

function isExplicitTrackButton(rawText = '') {
  return /^[🎵🎶🎧]/u.test(clean(rawText));
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

function isGenericAlbumNavigationText(rawText = '') {
  const body = normalize(stripLeadingEmoji(rawText));
  return /^(?:آلبوم|البوم)(?: ها| های)?$/u.test(body)
    || /^albums?$/iu.test(body)
    || /^(?:دیسکوگرافی|discography)$/iu.test(body)
    || /^(?:مشاهده|لیست|list|view)\s+(?:آلبوم|البوم|albums?)(?: ها| های)?$/iu.test(body);
}

export function parseTrackButton(rawText, fallbackArtist = '') {
  const original = clean(rawText);
  if (!original || isControl(original)) return null;
  if (!isExplicitTrackButton(original) && looksLikeAlbumButton(original)) return null;
  if (/^[🗣🎤🎙]/u.test(original)) return null;
  if (/^[💿📀]/u.test(original)) return null;

  if (looksLikeAlbumNavigationText(original)) return null;

  const popularity = parsePopularity(original);
  // MeloBot ranked feeds prefix rows like "#49 🎵 Artist, Title x 10k".
  // Strip the rank marker before artist/title parsing; otherwise the crawler
  // permanently invents artists such as "49 🎵 Artist".
  let value = stripFeedRankPrefix(original);
  value = stripLeadingEmoji(value);
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
        artistInferred: true,
        title,
        sourcePopularityText: popularity.text,
        sourcePopularityCount: popularity.count,
        sourceStateVersion,
      };
    }
  }

  return null;
}

export function parseAlbumButton(rawText, { allowBareCounted = false } = {}) {
  const original = clean(rawText);
  if (!original || isControl(original)) return null;

  const value = toAsciiDigits(stripLeadingEmoji(original));
  const counted = value.match(/^(.+?)\s*\((\d+)\)\s*$/u);
  if (counted && (allowBareCounted || /^[💿📀]/u.test(original))) {
    return {
      type: 'album',
      rawText: original,
      title: clean(counted[1]),
      trackCount: Number(counted[2]),
      sourceStateVersion,
    };
  }

  // MeloBot search surfaces sometimes expose album rows with a disc icon but
  // without the usual "(track count)" suffix. Keep them typed as albums so a
  // comma or dash inside the label can never turn them into fake tracks.
  if (/^[💿📀]/u.test(original) && !isGenericAlbumNavigationText(original)) {
    const body = clean(stripLeadingEmoji(original));
    if (!body) return null;

    const comma = body.indexOf(',');
    if (comma > 0) {
      const artist = clean(body.slice(0, comma));
      const title = clean(body.slice(comma + 1));
      if (artist && title) {
        return {
          type: 'album',
          rawText: original,
          artist,
          title,
          sourceStateVersion,
        };
      }
    }

    const dashed = body.match(/^(.+?)\s+[–—-]\s+(.+)$/u);
    if (dashed) {
      const artist = clean(dashed[1]);
      const title = clean(dashed[2]);
      if (artist && title) {
        return {
          type: 'album',
          rawText: original,
          artist,
          title,
          sourceStateVersion,
        };
      }
    }

    return {
      type: 'album',
      rawText: original,
      title: body,
      sourceStateVersion,
    };
  }

  return null;
}

function parseSearchAlbumButton(rawText) {
  if (isExplicitTrackButton(rawText)) return null;

  const album = parseAlbumButton(rawText);
  if (!album || album.artist || !/^[💿📀]/u.test(clean(rawText))) return album;

  const body = toAsciiDigits(stripLeadingEmoji(rawText))
    .replace(/\s*\(\d+\)\s*$/u, '')
    .trim();

  const comma = body.indexOf(',');
  if (comma > 0) {
    const artist = clean(body.slice(0, comma));
    const title = clean(body.slice(comma + 1));
    if (artist && title) return { ...album, artist, title };
  }

  const dashed = body.match(/^(.+?)\s+[–—-]\s+(.+)$/u);
  if (dashed) {
    const artist = clean(dashed[1]);
    const title = clean(dashed[2]);
    if (artist && title) return { ...album, artist, title };
  }

  return album;
}

function parseAlbumButtons(messages = [], { allowBareCounted = false } = {}) {
  const albums = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(messages)) {
    const album = parseAlbumButton(rawText, { allowBareCounted });
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
  // Keep the declaration and its reply keyboard coupled to the same Telegram
  // message. A previous implementation joined all response text first, so an
  // "albums (N)" message could accidentally authorize bare counted buttons
  // from a later artist/category message in the same collection window.
  const albums = [];
  const seen = new Set();
  let declaredCount = null;
  let explicitEmpty = false;

  for (const message of messages || []) {
    const localDeclaration = albumListingDeclaration([message]);
    if (localDeclaration.declaredCount !== null) {
      declaredCount = localDeclaration.declaredCount;
    }
    explicitEmpty = explicitEmpty || localDeclaration.explicitEmpty;

    const localAlbums = parseAlbumButtons([message], {
      allowBareCounted:
        localDeclaration.declaredCount !== null
        || localDeclaration.explicitEmpty,
    });

    for (const album of localAlbums) {
      const key = normalize(album.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      albums.push({
        ...album,
        verifiedAlbum: true,
        albumTrustVersion: 2,
      });
    }
  }

  const nextButton = albumNextButton(messages);
  const body = (messages || [])
    .map(messageText)
    .filter(Boolean)
    .join(' ');
  const explicitListingSurface = declaredCount !== null
    || explicitEmpty
    || /(?:آلبوم|البوم|album).*(?:انتخاب|خواننده|لیست|list|choose|artist)/iu.test(body)
    || /(?:انتخاب|لیست|choose|list).*(?:آلبوم|البوم|album)/iu.test(body);
  const confirmed = albums.length > 0
    || declaredCount !== null
    || explicitEmpty;
  const confirmedEmpty = albums.length === 0 && explicitEmpty;
  const complete = confirmedEmpty
    || (albums.length > 0 && explicitListingSurface && (
      declaredCount !== null
        ? albums.length >= declaredCount
        : !nextButton
    ));

  return {
    albums,
    declaredCount,
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

export function parseMeloBotSearchSurface(messages = [], fallbackArtist = '') {
  const tracks = parseTracksFromMessages(messages, fallbackArtist);
  const albums = [];
  const albumSeen = new Set();

  for (const rawText of buttonsFromMessages(messages)) {
    const album = parseSearchAlbumButton(rawText);
    if (!album) continue;
    const key = `${normalize(album.artist || '')}|${normalize(album.title)}`;
    if (!normalize(album.title) || albumSeen.has(key)) continue;
    albumSeen.add(key);
    albums.push({
      ...album,
      verifiedAlbum: true,
      albumTrustVersion: 2,
    });
  }

  return {
    tracks,
    albums,
    buttons: buttonsFromMessages(messages),
  };
}

async function sendAndCollect(client, text, {
  timeoutMs = config.searchTimeoutMs,
  quietMs = 650,
  stopWhen,
  stopWhenBatch,
  waitForTarget = false,
  reconcileOnTimeout = false,
  onMessage,
} = {}) {
  const peer = config.melobotUsername;
  const afterId = await latestMessageId(client, peer);
  const afterSequence = getTelegramInboxSequence(client);

  // Any outbound command moves the one shared MeloBot conversation. Callers
  // that know the resulting surface explicitly restore Track/More state after
  // the target is verified.
  liveTrackSurface = null;
  liveMoreSurface = null;
  const stateVersion = ++sourceStateVersion;
  await client.sendMessage(peer, { message: text });
  const result = await collectNewMessages(client, peer, afterId, {
    timeoutMs,
    quietMs,
    stopWhen,
    stopWhenBatch,
    waitForTarget,
    reconcileOnTimeout,
    afterSequence,
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
  timeoutMs = Math.min(config.searchTimeoutMs, 6000),
} = {}) {
  const remaining = sourceBudget(timeoutMs, 6000);
  let albums = mergeAlbumPages([], initial?.albums || [], maxAlbums);
  let declaredCount = initial?.declaredCount ?? null;
  let confirmedEmpty = Boolean(initial?.confirmedEmpty);
  let nextButton = initial?.nextButton || null;
  let pages = 1;
  let complete = Boolean(initial?.complete);
  const seenPages = new Set();

  while (
    !complete
    && nextButton
    && pages < maxPages
    && albums.length < maxAlbums
    && !remaining.expired()
  ) {
    const page = await sendAndCollect(client, nextButton, {
      timeoutMs: remaining(),
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

export async function searchMeloBotTyped(client, query, {
  maxRefinements = 3,
  timeoutMs = config.searchTimeoutMs,
} = {}) {
  const requested = clean(query);
  const remaining = sourceBudget(timeoutMs, config.searchTimeoutMs);
  if (!requested) throw new Error('MeloBot search query is empty.');

  let command = requested;
  let fallbackArtist = '';
  const seenTransitions = new Set();
  const allMessages = [];

  for (let step = 0; step <= Math.max(0, Number(maxRefinements || 0)); step += 1) {
    if (!normalize(command) || remaining.expired()) break;

    const result = await sendAndCollect(client, command, {
      timeoutMs: remaining(),
      quietMs: 350,
      stopWhen: message => {
        const surface = parseMeloBotSearchSurface([message], fallbackArtist);
        if (surface.tracks.length || surface.albums.length) return true;
        return Boolean(chooseMeloBotSearchRefinement([message], requested));
      },
      waitForTarget: true,
      reconcileOnTimeout: true,
    });
    allMessages.push(...(result.messages || []));

    const surface = parseMeloBotSearchSurface(result.messages, fallbackArtist);
    if (surface.tracks.length || surface.albums.length) {
      const albums = surface.albums.map(album =>
        album.artist || !fallbackArtist
          ? album
          : { ...album, artist: fallbackArtist }
      );
      return {
        ...surface,
        albums,
        messages: result.messages || [],
        sourceStateVersion,
        steps: step + 1,
      };
    }

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
    `MeloBot search returned no usable results. ${describeMeloBotSurface(allMessages)}`
  );
}

export async function searchMeloBot(client, query, options = {}) {
  try {
    const result = await searchMeloBotTyped(client, query, options);
    if (result.tracks.length) return result.tracks;
    throw new Error(
      `MeloBot search returned albums but no usable tracks. ${describeMeloBotSurface(result.messages)}`
    );
  } catch (err) {
    if (/no usable results/i.test(err.message || '')) {
      throw new Error(
        String(err.message).replace(/no usable results/i, 'no usable tracks')
      );
    }
    throw err;
  }
}

function isTrackMenuSurface(messages = []) {
  return buttonsFromMessages(messages).some(text => {
    const value = clean(text);
    return (
      (value.includes('کیفیت عالی') || value.includes('کیفیت معمولی'))
      && !value.includes('دانلود همه')
    );
  });
}

function inspectSelectedCandidateSurface(messages = [], candidate = {}) {
  if (isTrackMenuSurface(messages)) {
    return { kind: 'track', tracks: [] };
  }

  const fallbackArtist = candidate?.artist || '';
  const tracks = parseTracksFromMessages(messages, fallbackArtist);
  const buttons = buttonsFromMessages(messages);
  const hasBulk = buttons.some(text => /دانلود همه/u.test(clean(text)));
  const body = (messages || []).map(messageText).filter(Boolean).join(' ');
  const albumPrompt = /(?:آلبوم|البوم|album)/iu.test(body);

  if (tracks.length && (hasBulk || albumPrompt)) {
    return {
      kind: 'album',
      tracks,
      bulkHighButton: buttons.find(text =>
        /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
      ) || null,
      bulkNormalButton: buttons.find(text =>
        /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
      ) || null,
    };
  }

  return { kind: 'unknown', tracks: [] };
}


function exactNestedTrackButton(messages = [], candidate = {}) {
  const wantedTitle = titleIdentity(candidate?.title || '');
  if (!wantedTitle) return null;

  for (const rawText of buttonsFromMessages(messages)) {
    const track = parseTrackButton(rawText, candidate?.artist || '');
    if (!track || titleIdentity(track.title || '') !== wantedTitle) continue;
    if (
      candidate?.artist
      && track?.artist
      && !artistIdentityCompatible(candidate.artist, track.artist)
    ) continue;
    return rawText;
  }
  return null;
}

async function followNestedTrackSurface(
  client,
  messages,
  candidate,
  {
    clickedText = '',
    timeoutMs = 1800,
    allowAlbumSurface = false,
  } = {}
) {
  const nestedButton = exactNestedTrackButton(messages, candidate);
  if (!nestedButton || clean(nestedButton) === clean(clickedText)) return null;

  const nested = await sendAndCollect(client, nestedButton, {
    timeoutMs: Math.max(700, Number(timeoutMs || 1800)),
    quietMs: 450,
    stopWhen: message =>
      hasTrackActionMenu([message])
      || inspectSelectedCandidateSurface([message], candidate).kind === 'album',
    stopWhenBatch: batch =>
      hasTrackActionMenu(batch)
      || inspectSelectedCandidateSurface(batch, candidate).kind === 'album',
    waitForTarget: true,
    reconcileOnTimeout: true,
  });

  if (hasTrackActionMenu(nested.messages)) {
    const refreshed = { ...candidate, sourceStateVersion: nested.stateVersion };
    rememberLiveTrackSurface(client, refreshed, nested.messages, nested.stateVersion);
    return {
      messages: nested.messages,
      candidate: refreshed,
      route: 'nested_track_refinement',
    };
  }

  const surface = inspectSelectedCandidateSurface(nested.messages, candidate);
  if (allowAlbumSurface && surface.kind === 'album') {
    return {
      messages: nested.messages,
      candidate: { ...candidate, sourceStateVersion: nested.stateVersion },
      route: 'nested_album_refinement',
    };
  }
  return null;
}

function exactSearchTrackMatch(query, tracks = []) {
  const wanted = normalize(query);
  if (!wanted) return null;

  return (tracks || []).find(track => {
    const forward = normalize(
      [track?.artist, track?.title].filter(Boolean).join(' ')
    );
    const reverse = normalize(
      [track?.title, track?.artist].filter(Boolean).join(' ')
    );
    return wanted === forward || wanted === reverse;
  }) || null;
}

export async function classifyMeloBotTypedSearchExact(
  client,
  query,
  typedResult = {},
  { probeTimeoutMs = EXACT_SEARCH_PROBE_TIMEOUT_MS } = {}
) {
  let tracks = [...(typedResult.tracks || [])];
  let albums = [...(typedResult.albums || [])];
  let exactProbe = 'not_needed';

  const exact = exactSearchTrackMatch(query, tracks);
  if (exact?.rawText) {
    const confidentTrack = Number.isFinite(exact.sourcePopularityCount);
    const sameNamedAlbum = albums.some(album =>
      normalize(album.artist || '') === normalize(exact.artist || '')
      && normalize(album.title || '') === normalize(exact.title || '')
    );

    // Popularity is normally strong evidence for a real track, but when the
    // same live search surface simultaneously exposes an album with the exact
    // same artist/title, the row is genuinely ambiguous. Probe that rare case
    // instead of trusting the metric blindly.
    if (confidentTrack && !sameNamedAlbum) {
      exactProbe = 'skipped_confident_track';
    } else {
      try {
        const probed = await probeMeloBotCandidateSurface(
          client,
          exact,
          { timeoutMs: probeTimeoutMs }
        );
        exactProbe = probed.kind || 'unknown';
        if (probed.kind === 'album' && probed.album?.title) {
          tracks = tracks.filter(track => track !== exact);
          const promoted = {
            ...probed.album,
            artist: probed.album.artist || exact.artist,
          };
          const key = `${normalize(promoted.artist || '')}|${normalize(promoted.title || '')}`;
          const existingIndex = albums.findIndex(album =>
            `${normalize(album.artist || '')}|${normalize(album.title || '')}` === key
          );
          if (existingIndex >= 0) {
            albums[existingIndex] = {
              ...albums[existingIndex],
              ...promoted,
              trackCount: promoted.trackCount || albums[existingIndex].trackCount,
              tracks: promoted.tracks?.length
                ? promoted.tracks
                : albums[existingIndex].tracks,
            };
          } else {
            albums.unshift(promoted);
          }
        }
      } catch (err) {
        exactProbe = 'failed';
        console.warn('[melobot exact candidate probe]', err.message);
      }
    }
  }

  return {
    ...typedResult,
    tracks,
    albums,
    exactProbe,
  };
}

export async function probeMeloBotCandidateSurface(
  client,
  candidate,
  { timeoutMs = EXACT_SEARCH_PROBE_TIMEOUT_MS } = {}
) {
  if (!candidate?.rawText) {
    throw new Error('MeloBot candidate surface probe requires a raw button.');
  }
  if (Number(candidate.sourceStateVersion || -1) !== sourceStateVersion) {
    throw new Error('MeloBot candidate surface is stale.');
  }

  const selected = await sendAndCollect(client, candidate.rawText, {
    timeoutMs,
    quietMs: 550,
  });
  const inspected = inspectSelectedCandidateSurface(selected.messages, candidate);

  if (inspected.kind === 'track') {
    rememberLiveTrackSurface(
      client,
      { ...candidate, sourceStateVersion: selected.stateVersion },
      selected.messages,
      selected.stateVersion
    );
  }

  if (inspected.kind === 'album') {
    return {
      ...inspected,
      album: {
        type: 'album',
        artist: candidate.artist || undefined,
        title: candidate.title || stripMetricSuffix(stripLeadingEmoji(candidate.rawText)),
        rawText: candidate.rawText,
        trackCount: inspected.tracks.length || undefined,
        sourceStateVersion,
        bulkHighButton: inspected.bulkHighButton,
        bulkNormalButton: inspected.bulkNormalButton,
        tracks: inspected.tracks,
        verifiedAlbum: true,
        albumTrustVersion: 2,
      },
      messages: selected.messages,
      sourceStateVersion,
    };
  }

  return {
    ...inspected,
    candidate,
    messages: selected.messages,
    sourceStateVersion,
  };
}

async function findArtistSeed(
  client,
  artist,
  preferredSeed = null,
  { timeoutMs = config.searchTimeoutMs } = {}
) {
  const target = normalize(artist);
  const preferredArtist = normalize(preferredSeed?.artist || '');

  // Reuse a preferred seed only while its source row/surface is genuinely
  // current. A stale preferred seed used to force a slow resolve->click cycle
  // for every Artist Top/Recent request; a fresh artist search is both faster
  // and more reliable once the shared MeloBot state has moved elsewhere.
  const preferredStillLive = Boolean(
    currentLiveTrackSurface(client, preferredSeed || {})
    || currentLiveMoreSurface(client, preferredSeed || {})
  );
  if (
    preferredSeed?.rawText
    && preferredSeed?.source !== 'ahangify'
    && preferredArtist
    && artistIdentityCompatible(artist, preferredSeed.artist)
    && (
      Number(preferredSeed.sourceStateVersion || -1) === Number(sourceStateVersion)
      || preferredStillLive
    )
  ) {
    return preferredSeed;
  }

  let seed = null;
  try {
    const results = await searchMeloBot(client, artist, {
      timeoutMs,
      maxRefinements: 3,
    });
    seed = results.find(track => normalize(track.artist) === target)
      || results.find(track =>
        artistIdentityCompatible(artist, track.artist || '')
      )
      || null;
  } catch (err) {
    console.warn('[melobot artist seed]', artist, err.message);
  }

  if (!seed) throw new Error(`No usable MeloBot seed track found for artist: ${artist}`);
  return seed;
}

export async function openMeloBotArtistFresh(
  client,
  artist,
  preferredSeed = null,
  { timeoutMs = 9000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  const seed = await findArtistSeed(
    client,
    artist,
    preferredSeed,
    { timeoutMs: remaining() }
  );
  return openMeloBotArtist(client, seed, { timeoutMs: remaining() });
}

export async function resolveMeloBotTrackCandidate(
  client,
  candidate,
  {
    timeoutMs = config.searchTimeoutMs,
    forceIdentity = false,
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, config.searchTimeoutMs);
  const primaryQuery = [candidate?.artist, candidate?.title].filter(Boolean).join(' ')
    || candidate?.title
    || candidate?.rawText;

  if (!primaryQuery) throw new Error('MeloBot track candidate is incomplete.');

  if (
    candidate?.rawText
    && Number(candidate.sourceStateVersion || -1) === sourceStateVersion
    && (!candidate.artistInferred || !forceIdentity)
  ) {
    return candidate;
  }

  const title = normalize(candidate?.title || '');
  const artist = normalize(candidate?.artist || '');
  const baseTitle = clean(candidate?.title || '')
    .replace(/\s*\((?:feat\.?|ft\.?|featuring)\s+[^)]+\)\s*$/iu, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '')
    .trim();

  // Featured/collaboration spelling varies heavily on MeloBot. Search a
  // durable base-title form first, then verify the exact title identity and
  // artist compatibility before accepting a row.
  const collaborationCredit = artistIdentityParts(candidate?.artist || '').length > 1;
  const featuredTitle = baseTitle && normalize(baseTitle) !== normalize(candidate?.title || '');
  let queries;
  if (candidate?.artistInferred) {
    // Title-only rows must first ask for the exact visible title so MeloBot can
    // reveal the authoritative primary performer.
    queries = [
      candidate?.title,
      baseTitle,
      [candidate?.artist, baseTitle].filter(Boolean).join(' '),
      primaryQuery,
    ];
  } else if (collaborationCredit) {
    // Collaboration credits are commonly reordered by the source; title-first
    // search plus strict artist-set verification is the stable resolver.
    queries = [
      baseTitle || candidate?.title,
      candidate?.title,
      primaryQuery,
    ];
  } else if (featuredTitle) {
    queries = [
      [candidate?.artist, baseTitle].filter(Boolean).join(' '),
      baseTitle,
      primaryQuery,
      candidate?.title,
    ];
  } else {
    queries = [primaryQuery, candidate?.title];
  }
  const uniqueQueries = [...new Set(queries.map(clean).filter(Boolean))];

  let lastError = null;
  for (let index = 0; index < uniqueQueries.length; index += 1) {
    if (remaining.expired()) break;
    const query = uniqueQueries[index];
    const attemptsLeft = uniqueQueries.length - index;
    const left = remaining();
    const queryBudget = attemptsLeft > 1
      ? Math.max(450, Math.min(2400, left - 800))
      : left;
    try {
      const results = await searchMeloBot(client, query, {
        timeoutMs: queryBudget,
        maxRefinements: 2,
      });

      const requestedTitle = titleIdentity(candidate?.title || '');
      const exactTitle = results.filter(track =>
        requestedTitle
        && titleIdentity(track.title || '') === requestedTitle
      );

      let resolved = null;
      if (candidate?.artistInferred) {
        // A title-only page row may legitimately reveal a different primary
        // source artist. Still require the title itself to match.
        resolved = exactTitle.find(track => track.artist && !track.artistInferred)
          || exactTitle[0]
          || null;
      } else {
        resolved = exactTitle.find(track =>
          artistIdentityCompatible(candidate?.artist || '', track.artist || '')
        ) || null;
      }

      // Never fall back to results[0]. Returning an unrelated Track is worse
      // than a recoverable resolve failure and previously caused cases like
      // Xaniar — Shabe Mahtab resolving to Ehaam — Boghze Modaam.
      if (resolved) {
        return {
          ...resolved,
          artistInferred: false,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) console.warn('[melobot resolve track]', lastError.message);
  throw meloError(
    'MELOBOT_TRACK_RESOLVE_FAILED',
    `MeloBot could not resolve the requested Track exactly: ${trackLabel(candidate)}`
  );
}

async function openTrackMenuWithCandidate(
  client,
  candidate,
  {
    timeoutMs = config.searchTimeoutMs,
    directTimeoutMs = 3000,
    resolveTimeoutMs = 3500,
    menuTimeoutMs = 4000,
    allowAlbumSurface = false,
  } = {}
) {
  const requested = candidate || {};
  const directText = clean(requested.rawText || '');
  const cap = Math.max(1800, Number(timeoutMs || config.searchTimeoutMs));
  const remaining = sourceBudget(cap, cap);
  const stepTimeout = requestedMs =>
    Math.max(25, Math.min(Math.max(25, Number(requestedMs || 0)), remaining()));

  const liveSurface = currentLiveTrackSurface(client, requested);
  if (liveSurface) {
    console.log(
      `[melobot.track_menu] route=live_surface track=${JSON.stringify(trackLabel(requested))}`
    );
    return {
      messages: liveSurface.messages,
      candidate: {
        ...requested,
        sourceStateVersion: liveSurface.version,
      },
      route: 'live_track_surface',
    };
  }

  // Cover/metadata can leave MeloBot on the More submenu. Return to the Track
  // menu with the live Back control instead of throwing the whole context away
  // and performing another search.
  const liveMore = currentLiveMoreSurface(client, requested);
  if (liveMore) {
    const backButton = findButton(liveMore.messages, text => {
      const value = clean(text);
      return /^⬅️/u.test(value) || /بازگشت/u.test(value);
    });
    if (backButton) {
      const back = await sendAndCollect(client, backButton, {
        timeoutMs: stepTimeout(2200),
        quietMs: 500,
        stopWhen: message => hasTrackActionMenu([message]),
        stopWhenBatch: messages => hasTrackActionMenu(messages),
        waitForTarget: true,
        reconcileOnTimeout: true,
      });
      if (hasTrackActionMenu(back.messages)) {
        const restoredCandidate = {
          ...requested,
          sourceStateVersion: back.stateVersion,
        };
        rememberLiveTrackSurface(client, restoredCandidate, back.messages, back.stateVersion);
        console.log(
          `[melobot.track_menu] route=more_back track=${JSON.stringify(trackLabel(requested))}`
        );
        return {
          messages: back.messages,
          candidate: restoredCandidate,
          route: 'more_back',
        };
      }
    }
  }

  const canClickCurrentSurface = Boolean(
    directText
    && Number(requested.sourceStateVersion || -1) === Number(sourceStateVersion)
  );

  if (canClickCurrentSurface) {
    const direct = await sendAndCollect(client, directText, {
      timeoutMs: stepTimeout(Math.max(1800, Number(directTimeoutMs || 3000))),
      quietMs: 550,
      stopWhen: m =>
        hasTrackActionMenu([m])
        || inspectSelectedCandidateSurface([m], requested).kind === 'album'
        || Boolean(exactNestedTrackButton([m], requested)),
      stopWhenBatch: messages =>
        hasTrackActionMenu(messages)
        || inspectSelectedCandidateSurface(messages, requested).kind === 'album'
        || Boolean(exactNestedTrackButton(messages, requested)),
      waitForTarget: true,
      reconcileOnTimeout: true,
    });
    if (hasTrackActionMenu(direct.messages)) {
      const liveCandidate = {
        ...requested,
        sourceStateVersion: direct.stateVersion,
      };
      rememberLiveTrackSurface(client, liveCandidate, direct.messages, direct.stateVersion);
      console.log(`[melobot.track_menu] route=direct track=${JSON.stringify(trackLabel(requested))}`);
      return { messages: direct.messages, candidate: liveCandidate, route: 'direct_raw_text' };
    }
    const directSurface = inspectSelectedCandidateSurface(direct.messages, requested);
    if (allowAlbumSurface && directSurface.kind === 'album') {
      console.log(`[melobot.track_menu] route=direct_album track=${JSON.stringify(trackLabel(requested))}`);
      return {
        messages: direct.messages,
        candidate: { ...requested, sourceStateVersion: direct.stateVersion },
        route: 'direct_album',
      };
    }

    const refined = await followNestedTrackSurface(
      client,
      direct.messages,
      requested,
      {
        clickedText: directText,
        timeoutMs: stepTimeout(1600),
        allowAlbumSurface,
      }
    );
    if (refined) {
      console.log(
        `[melobot.track_menu] route=${refined.route} track=${JSON.stringify(trackLabel(requested))}`
      );
      return refined;
    }

    console.log(
      `[melobot.track_menu] route=direct_miss track=${JSON.stringify(trackLabel(requested))} surface=${describeMeloBotSurface(direct.messages)}`
    );
  } else if (directText) {
    console.log(
      `[melobot.track_menu] route=stale_surface_refresh track=${JSON.stringify(trackLabel(requested))}`
    );
  }

  if (remaining.expired()) {
    throw meloError(
      'MELOBOT_TRACK_MENU_TIMEOUT',
      `MeloBot track recovery budget exhausted for: ${trackLabel(requested)}`
    );
  }

  const liveCandidate = await resolveMeloBotTrackCandidate(
    client,
    requested,
    {
      timeoutMs: stepTimeout(Math.max(2000, Number(resolveTimeoutMs || 3500))),
      forceIdentity: Boolean(requested.artistInferred),
    }
  );
  if (!liveCandidate?.rawText) {
    throw meloError('MELOBOT_TRACK_RESOLVE_FAILED', 'MeloBot live track button was not found.');
  }

  if (remaining.expired()) {
    throw meloError(
      'MELOBOT_TRACK_MENU_TIMEOUT',
      `MeloBot track-menu budget exhausted for: ${trackLabel(liveCandidate)}`
    );
  }

  const selected = await sendAndCollect(client, liveCandidate.rawText, {
    timeoutMs: stepTimeout(Math.max(2200, Number(menuTimeoutMs || 4000))),
    quietMs: 550,
    stopWhen: m =>
      hasTrackActionMenu([m])
      || inspectSelectedCandidateSurface([m], liveCandidate).kind === 'album'
      || Boolean(exactNestedTrackButton([m], liveCandidate)),
    stopWhenBatch: messages =>
      hasTrackActionMenu(messages)
      || inspectSelectedCandidateSurface(messages, liveCandidate).kind === 'album'
      || Boolean(exactNestedTrackButton(messages, liveCandidate)),
    waitForTarget: true,
    reconcileOnTimeout: true,
  });
  if (!hasTrackActionMenu(selected.messages)) {
    const selectedSurface = inspectSelectedCandidateSurface(selected.messages, liveCandidate);
    if (allowAlbumSurface && selectedSurface.kind === 'album') {
      return {
        messages: selected.messages,
        candidate: { ...liveCandidate, sourceStateVersion: selected.stateVersion },
        route: 'resolved_album',
      };
    }

    const refined = await followNestedTrackSurface(
      client,
      selected.messages,
      liveCandidate,
      {
        clickedText: liveCandidate.rawText,
        timeoutMs: stepTimeout(1700),
        allowAlbumSurface,
      }
    );
    if (refined) {
      console.log(
        `[melobot.track_menu] route=${refined.route} track=${JSON.stringify(trackLabel(liveCandidate))}`
      );
      return refined;
    }

    throw meloError(
      'MELOBOT_TRACK_MENU_TIMEOUT',
      `MeloBot track menu did not arrive for: ${trackLabel(liveCandidate)} surface=${describeMeloBotSurface(selected.messages)}`
    );
  }
  const refreshedCandidate = {
    ...liveCandidate,
    sourceStateVersion: selected.stateVersion,
  };
  rememberLiveTrackSurface(client, refreshedCandidate, selected.messages, selected.stateVersion);
  console.log(`[melobot.track_menu] route=resolved track=${JSON.stringify(trackLabel(liveCandidate))}`);
  return { messages: selected.messages, candidate: refreshedCandidate, route: 'resolved_search' };
}

async function openTrackMenu(client, candidate) {
  return (await openTrackMenuWithCandidate(client, candidate)).messages;
}

export async function downloadMeloBotTrack(
  client,
  candidate,
  { timeoutMs = 15000 } = {}
) {
  const result = await downloadMeloBotTrackQuality(
    client,
    candidate,
    'hq',
    {
      timeoutMs,
      menuTimeoutMs: Math.min(5000, timeoutMs),
    }
  );
  return {
    source: 'melobot',
    candidate: result.candidate || candidate,
    audioMessage: result.audioMessage,
  };
}


export async function downloadMeloBotTrackQuality(
  client,
  candidate,
  quality = 'hq',
  {
    timeoutMs = config.downloadTimeoutMs,
    menuTimeoutMs = 4000,
    deliveryTimeoutMs = 7000,
  } = {}
) {
  const openedMenu = await openTrackMenuWithCandidate(
    client,
    candidate,
    {
      timeoutMs: Math.max(3000, Number(timeoutMs || config.downloadTimeoutMs)),
      directTimeoutMs: Math.min(3000, menuTimeoutMs),
      resolveTimeoutMs: Math.min(3500, menuTimeoutMs),
      menuTimeoutMs,
    }
  );
  const menuMessages = openedMenu.messages;
  const liveCandidate = openedMenu.candidate || candidate;
  const wantsHigh = quality === 'hq';
  const button = findButton(menuMessages, text => {
    const value = clean(text);
    if (wantsHigh) return value.includes('کیفیت عالی') && !value.includes('خرید اشتراک');
    return value.includes('کیفیت معمولی') && !value.includes('دانلود همه');
  });

  if (!button) {
    throw meloError(
      'MELOBOT_CAPABILITY_ABSENT',
      `MeloBot ${quality} quality button not found.`,
      { capability: quality === 'hq' ? 'hasHq' : 'hasNormal' }
    );
  }

  console.log(
    `[melobot.quality] stage=button_found quality=${quality} track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  await sleep(220);
  const result = await sendAndCollect(client, button, {
    timeoutMs: Math.max(500, Number(deliveryTimeoutMs || 7000)),
    quietMs: 650,
    stopWhen: isAudioMessage,
    waitForTarget: true,
    reconcileOnTimeout: true,
    onMessage: message => {
      console.log('[melobot.quality.incoming]', JSON.stringify(describeTargetMessage(message)));
    },
  });

  const audio = result.messages.find(isAudioMessage);
  if (!audio) {
    const response = result.messages.map(messageText).filter(Boolean).join('\n');
    throw meloError(
      'MELOBOT_DELIVERY_TIMEOUT',
      `MeloBot did not deliver ${quality} audio after the quality button was confirmed. ${response.slice(0, 350)}`,
      { capability: quality === 'hq' ? 'hasHq' : 'hasNormal' }
    );
  }

  const refreshedCandidate = {
    ...liveCandidate,
    sourceStateVersion: result.stateVersion,
  };

  // MeloBot keeps the selected Track context after sending an audio file. Keep
  // the verified Track-menu snapshot hot so an immediate Normal/HQ follow-up
  // does not perform another search. Any unrelated source command invalidates
  // this snapshot in sendAndCollect().
  rememberLiveTrackSurface(client, refreshedCandidate, menuMessages, result.stateVersion);

  console.log(
    `[melobot.quality] stage=audio_received quality=${quality} track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  return {
    source: 'melobot',
    quality,
    candidate: refreshedCandidate,
    audioMessage: audio,
  };
}

function photoMessage(message) {
  return Boolean(message?.media?.photo);
}

function isMoreMenuSurface(message = {}) {
  // Do not stop on the explanatory text alone. MeloBot can send the text
  // first and attach/edit the reply keyboard a moment later. A keyboard plus
  // the More-menu prompt is enough to confirm the submenu even when a
  // particular capability (for example Cover) is genuinely absent.
  const buttons = replyButtons(message);
  if (!buttons.length) return false;
  if (buttons.some(text =>
    /کاور|بقیه\s*مشخصات|مشخصات|متن\s*آهنگ/u.test(clean(text))
  )) return true;

  return /اینجا\s+امکانات\s+بیشتری|امکانات\s+بیشتری/u.test(
    messageText(message)
  );
}

async function openMoreMenuFromSurface(
  client,
  menuMessages = [],
  {
    timeoutMs = 3000,
    capability = 'more',
  } = {}
) {
  const moreButton = findButton(menuMessages, text => /بیشتر/u.test(clean(text)));
  if (!moreButton) {
    throw meloError(
      'MELOBOT_MORE_BUTTON_ABSENT',
      'MeloBot more button not found.',
      { capability }
    );
  }

  await sleep(180);
  const more = await sendAndCollect(client, moreButton, {
    timeoutMs: Math.max(500, Number(timeoutMs || 3000)),
    quietMs: 650,
    stopWhen: isMoreMenuSurface,
    waitForTarget: true,
    reconcileOnTimeout: true,
    onMessage: message => {
      console.log('[melobot.more.incoming]', JSON.stringify({
        ...describeTargetMessage(message),
        text: messageText(message).slice(0, 80),
        buttons: replyButtons(message).slice(0, 8),
      }));
    },
  });

  if (!more.messages?.length || !more.messages.some(isMoreMenuSurface)) {
    throw meloError(
      'MELOBOT_SUBMENU_TIMEOUT',
      'MeloBot more submenu did not reach a confirmed surface.',
      { capability }
    );
  }

  return more.messages;
}

async function openMoreMenu(
  client,
  candidate,
  { timeoutMs = config.searchTimeoutMs } = {}
) {
  const remaining = sourceBudget(timeoutMs);
  const menuMessages = (await openTrackMenuWithCandidate(
    client,
    candidate,
    { timeoutMs: remaining() }
  )).messages;

  return openMoreMenuFromSurface(
    client,
    menuMessages,
    { timeoutMs: remaining() }
  );
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

export async function getMeloBotLyrics(
  client,
  candidate,
  {
    timeoutMs = config.searchTimeoutMs,
    menuTimeoutMs = 4000,
    submenuTimeoutMs = 3000,
    deliveryTimeoutMs = 6500,
  } = {}
) {
  const openedMenu = await openTrackMenuWithCandidate(
    client,
    candidate,
    {
      timeoutMs: Math.max(3000, Number(timeoutMs || config.searchTimeoutMs)),
      directTimeoutMs: Math.min(3000, menuTimeoutMs),
      resolveTimeoutMs: Math.min(3500, menuTimeoutMs),
      menuTimeoutMs,
    }
  );
  const menuMessages = openedMenu.messages;
  const liveCandidate = openedMenu.candidate || candidate;

  let actionSurface = 'track';
  let actionSurfaceMessages = menuMessages;
  let lyricsButton = findButton(menuMessages, text => /متن\s*آهنگ/u.test(clean(text)));
  if (!lyricsButton) {
    const moreButton = findButton(menuMessages, text => /بیشتر/u.test(clean(text)));
    if (moreButton) {
      const moreMessages = await openMoreMenuFromSurface(
        client,
        menuMessages,
        {
          timeoutMs: Math.max(500, Number(submenuTimeoutMs || 3000)),
          capability: 'hasLyrics',
        }
      );
      actionSurface = 'more';
      actionSurfaceMessages = moreMessages;
      rememberLiveMoreSurface(
        client,
        liveCandidate,
        moreMessages,
        sourceStateVersion,
        menuMessages
      );
      lyricsButton = findButton(
        moreMessages,
        text => /متن\s*آهنگ/u.test(clean(text))
      );
    }
  }

  if (!lyricsButton) {
    console.log(
      `[melobot.lyrics] stage=button_absent track=${JSON.stringify(trackLabel(liveCandidate))}`
    );
    return { available: false, text: '', checked: true, candidate: liveCandidate };
  }

  console.log(
    `[melobot.lyrics] stage=button_found track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  await sleep(180);
  const result = await sendAndCollect(client, lyricsButton, {
    timeoutMs: Math.max(500, Number(deliveryTimeoutMs || 6500)),
    quietMs: 900,
    stopWhen: m => Boolean(messageText(m)),
    waitForTarget: true,
    reconcileOnTimeout: true,
    onMessage: message => {
      console.log('[melobot.lyrics.incoming]', JSON.stringify(describeTargetMessage(message)));
    },
  });

  const raw = result.messages.map(messageText).filter(Boolean).join('\n\n').trim();
  if (!raw) {
    throw meloError(
      'MELOBOT_DELIVERY_TIMEOUT',
      `MeloBot lyrics response was empty after the button was confirmed for: ${trackLabel(liveCandidate)}`,
      { capability: 'hasLyrics' }
    );
  }

  const refreshedCandidate = {
    ...liveCandidate,
    sourceStateVersion: result.stateVersion,
  };
  if (actionSurface === 'more') {
    rememberLiveMoreSurface(
      client,
      refreshedCandidate,
      actionSurfaceMessages,
      result.stateVersion,
      menuMessages
    );
  } else {
    rememberLiveTrackSurface(
      client,
      refreshedCandidate,
      actionSurfaceMessages,
      result.stateVersion
    );
  }

  const unavailable = /(?:متن|lyrics?).*(?:موجود نیست|وجود ندارد|ندارد|not available|unavailable)/iu
    .test(raw);
  if (unavailable) {
    return {
      available: false,
      text: '',
      rawText: raw,
      checked: true,
      candidate: refreshedCandidate,
    };
  }

  const text = sanitizeMeloBotLyricsText(raw, liveCandidate);
  if (!text) {
    throw meloError(
      'MELOBOT_RESPONSE_UNUSABLE',
      'MeloBot lyrics response contained no usable lyrics.',
      { capability: 'hasLyrics' }
    );
  }
  console.log(
    `[melobot.lyrics] stage=text_received track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  return {
    available: true,
    text,
    rawText: raw,
    checked: true,
    candidate: refreshedCandidate,
  };
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

export async function getMeloBotTrackMetadata(
  client,
  candidate,
  { timeoutMs = config.searchTimeoutMs } = {}
) {
  const remaining = sourceBudget(timeoutMs);
  const openedMenu = await openTrackMenuWithCandidate(
    client,
    candidate,
    { timeoutMs: remaining() }
  );
  const trackMenu = openedMenu.messages;
  const liveCandidate = openedMenu.candidate || candidate;

  let actionSurface = 'track';
  let detailsButton = findButton(
    trackMenu,
    text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text))
  );
  let surface = trackMenu;

  if (!detailsButton) {
    const moreButton = findButton(trackMenu, text => /بیشتر/u.test(clean(text)));
    if (moreButton) {
      surface = await openMoreMenuFromSurface(
        client,
        trackMenu,
        {
          timeoutMs: remaining(),
          capability: 'hasMetadata',
        }
      );
      actionSurface = 'more';
      rememberLiveMoreSurface(
        client,
        liveCandidate,
        surface,
        sourceStateVersion,
        trackMenu
      );
      detailsButton = findButton(
        surface,
        text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text))
      );
    }
  }

  if (!detailsButton) {
    const surfaceRaw = trackMenu.map(messageText).filter(Boolean).join('\n\n').trim();
    return {
      raw: surfaceRaw,
      ...parseReleaseDate(surfaceRaw),
      ...parsePopularityValue(surfaceRaw || liveCandidate.rawText || candidate.rawText || ''),
      candidate: liveCandidate,
    };
  }

  const result = await sendAndCollect(client, detailsButton, {
    timeoutMs: remaining(),
    quietMs: 650,
  });
  const raw = result.messages.map(messageText).filter(Boolean).join('\n\n').trim();
  const refreshedCandidate = {
    ...liveCandidate,
    sourceStateVersion: result.stateVersion,
  };
  if (actionSurface === 'more') {
    rememberLiveMoreSurface(
      client,
      refreshedCandidate,
      surface,
      result.stateVersion,
      trackMenu
    );
  } else {
    rememberLiveTrackSurface(
      client,
      refreshedCandidate,
      trackMenu,
      result.stateVersion
    );
  }
  return {
    raw,
    ...parseReleaseDate(raw),
    ...parsePopularityValue(raw || liveCandidate.rawText || candidate.rawText || ''),
    candidate: refreshedCandidate,
  };
}

export async function getMeloBotCover(
  client,
  candidate,
  {
    timeoutMs = config.searchTimeoutMs,
    menuTimeoutMs = 4000,
    submenuTimeoutMs = 3000,
    deliveryTimeoutMs = 6500,
  } = {}
) {
  const openedMenu = await openTrackMenuWithCandidate(
    client,
    candidate,
    {
      timeoutMs: Math.max(3000, Number(timeoutMs || config.searchTimeoutMs)),
      directTimeoutMs: Math.min(3000, menuTimeoutMs),
      resolveTimeoutMs: Math.min(3500, menuTimeoutMs),
      menuTimeoutMs,
    }
  );
  const trackMenu = openedMenu.messages;
  const liveCandidate = openedMenu.candidate || candidate;
  console.log(
    `[melobot.cover] stage=menu_received track=${JSON.stringify(trackLabel(liveCandidate))}`
  );

  let actionSurface = 'track';
  let actionSurfaceMessages = trackMenu;
  let coverButton = findButton(trackMenu, text => /کاور/u.test(clean(text)));

  if (!coverButton) {
    const moreButton = findButton(trackMenu, text => /بیشتر/u.test(clean(text)));
    if (moreButton) {
      console.log(
        `[melobot.cover] stage=more_found track=${JSON.stringify(trackLabel(liveCandidate))}`
      );
      const moreMessages = await openMoreMenuFromSurface(
        client,
        trackMenu,
        {
          timeoutMs: Math.max(500, Number(submenuTimeoutMs || 3000)),
          capability: 'hasCover',
        }
      );
      actionSurface = 'more';
      actionSurfaceMessages = moreMessages;
      rememberLiveMoreSurface(
        client,
        liveCandidate,
        moreMessages,
        sourceStateVersion,
        trackMenu
      );
      coverButton = findButton(moreMessages, text => /کاور/u.test(clean(text)));
    }
  }

  if (!coverButton) {
    console.log(
      `[melobot.cover] stage=button_absent track=${JSON.stringify(trackLabel(liveCandidate))}`
    );
    return {
      source: 'melobot',
      available: false,
      checked: true,
      reason: 'button_absent',
      candidate: liveCandidate,
      photoMessage: null,
    };
  }

  console.log(
    `[melobot.cover] stage=button_found track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  await sleep(180);
  const result = await sendAndCollect(client, coverButton, {
    timeoutMs: Math.max(500, Number(deliveryTimeoutMs || 6500)),
    quietMs: 650,
    stopWhen: photoMessage,
    waitForTarget: true,
    reconcileOnTimeout: true,
    onMessage: message => {
      console.log('[melobot.cover.incoming]', JSON.stringify(describeTargetMessage(message)));
    },
  });

  const photo = result.messages.find(photoMessage);
  if (!photo) {
    throw meloError(
      'MELOBOT_DELIVERY_TIMEOUT',
      `MeloBot cover button was confirmed but no photo arrived for: ${trackLabel(liveCandidate)}`,
      { capability: 'hasCover' }
    );
  }

  const refreshedCandidate = {
    ...liveCandidate,
    sourceStateVersion: result.stateVersion,
  };
  if (actionSurface === 'more') {
    rememberLiveMoreSurface(
      client,
      refreshedCandidate,
      actionSurfaceMessages,
      result.stateVersion,
      trackMenu
    );
  } else {
    rememberLiveTrackSurface(
      client,
      refreshedCandidate,
      actionSurfaceMessages,
      result.stateVersion
    );
  }

  console.log(
    `[melobot.cover] stage=photo_received track=${JSON.stringify(trackLabel(liveCandidate))}`
  );
  return {
    source: 'melobot',
    available: true,
    checked: true,
    photoMessage: photo,
    candidate: refreshedCandidate,
  };
}

export async function enrichMeloBotTrack(
  client,
  candidate,
  { timeoutMs = 9000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  const liveCandidate = await resolveMeloBotTrackCandidate(
    client,
    candidate,
    {
      timeoutMs: remaining(),
      forceIdentity: Boolean(candidate?.artistInferred),
    }
  );
  if (!liveCandidate?.rawText) {
    throw new Error('MeloBot live track button was not found.');
  }
  if (liveCandidate.artistInferred) {
    throw new Error('MeloBot primary artist identity is still inferred.');
  }

  const selected = await sendAndCollect(client, liveCandidate.rawText, {
    timeoutMs: remaining(),
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
    lyrics: { available: false, text: '', checked: false },
    cover: null,
    capabilities: {
      hasHq: menuButtons.some(text =>
        clean(text).includes('کیفیت عالی') && !clean(text).includes('خرید اشتراک')
      ),
      hasNormal: menuButtons.some(text =>
        clean(text).includes('کیفیت معمولی') && !clean(text).includes('دانلود همه')
      ),
      hasLyrics: menuButtons.some(text => /متن\s*آهنگ/u.test(clean(text))),
      hasCover: menuButtons.some(text => /کاور/u.test(clean(text))),
      hasMetadata: menuButtons.some(text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text))),
      hasArtistPage: Boolean(
        findArtistButtonFor(menuMessages, liveCandidate.artist || candidate?.artist || '')
      ),
    },
    errors: [],
  };

  let lyricsButton = menuButtons.find(text => /متن\s*آهنگ/u.test(clean(text))) || null;
  let extraMessages = menuMessages;
  const moreButton = menuButtons.find(text => /بیشتر/u.test(clean(text))) || null;
  let secondaryMenuConfirmed = !moreButton;

  if (moreButton && !remaining.expired()) {
    try {
      const moreMessages = await openMoreMenuFromSurface(
        client,
        menuMessages,
        {
          timeoutMs: remaining(),
          capability: 'track_enrich',
        }
      );
      if (!moreMessages?.length) {
        result.errors.push('more: empty response');
      } else {
        secondaryMenuConfirmed = true;
        extraMessages = moreMessages;
        const moreButtons = buttonsFromMessages(moreMessages);
        result.capabilities.hasCover ||= moreButtons.some(text => /کاور/u.test(clean(text)));
        result.capabilities.hasMetadata ||= moreButtons.some(text =>
          /بقیه\s*مشخصات|مشخصات/u.test(clean(text))
        );
        result.capabilities.hasLyrics ||= moreButtons.some(text => /متن\s*آهنگ/u.test(clean(text)));
        lyricsButton ||= moreButtons.find(text => /متن\s*آهنگ/u.test(clean(text))) || null;
      }
    } catch (err) {
      result.errors.push(`more: ${err.message}`);
    }
  } else if (moreButton && remaining.expired()) {
    result.errors.push('more: enrichment budget exhausted');
  }

  if (!lyricsButton) {
    // Absence is durable only when every menu that could contain Lyrics was
    // actually observed. A failed/empty More request remains "unknown".
    result.lyrics.checked = secondaryMenuConfirmed;
  } else if (!remaining.expired()) {
    try {
      const lyricsResult = await sendAndCollect(client, lyricsButton, {
        timeoutMs: remaining(),
        quietMs: 650,
      });
      const raw = lyricsResult.messages.map(messageText).filter(Boolean).join('\n\n').trim();
      const unavailable = /(?:متن|lyrics?).*(?:موجود نیست|وجود ندارد|ندارد|not available|unavailable)/iu
        .test(raw);
      const text = unavailable ? '' : sanitizeMeloBotLyricsText(raw, liveCandidate);
      result.lyrics = {
        available: Boolean(text),
        text,
        rawText: raw,
        checked: Boolean(raw && (text || unavailable)),
      };
      if (!raw) {
        result.errors.push('lyrics: empty response');
      }
    } catch (err) {
      result.errors.push(`lyrics: ${err.message}`);
    }
  }

  const extraButtons = buttonsFromMessages(extraMessages);
  const detailsButton = [
    ...menuButtons,
    ...extraButtons,
  ].find(text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text))) || null;

  if (detailsButton && !remaining.expired()) {
    try {
      const details = await sendAndCollect(client, detailsButton, {
        timeoutMs: remaining(),
        quietMs: 600,
      });
      const raw = details.messages.map(messageText).filter(Boolean).join('\n\n').trim();
      result.metadata = {
        raw,
        ...parseReleaseDate(raw),
        ...parsePopularityValue(raw || liveCandidate.rawText || candidate?.rawText || ''),
      };
      if (!raw) {
        result.errors.push('metadata: empty response');
      }
    } catch (err) {
      result.errors.push(`metadata: ${err.message}`);
    }
  }

  const coverButton = [
    ...menuButtons,
    ...extraButtons,
  ].find(text => /کاور/u.test(clean(text))) || null;

  if (coverButton && !remaining.expired()) {
    try {
      const coverResult = await sendAndCollect(client, coverButton, {
        timeoutMs: remaining(),
        quietMs: 600,
        stopWhen: photoMessage,
      });
      const photo = coverResult.messages.find(photoMessage);
      if (photo) {
        result.cover = { source: 'melobot', photoMessage: photo };
      } else {
        result.errors.push('cover: photo not delivered');
      }
    } catch (err) {
      result.errors.push(`cover: ${err.message}`);
    }
  }

  if (remaining.expired()) {
    result.errors.push('enrichment budget exhausted');
  }
  return result;
}

export async function discoverMeloBotFeed(
  client,
  command,
  {
    contentOrigin = 'unknown',
    timeoutMs = Math.min(config.searchTimeoutMs, 6000),
  } = {}
) {
  const result = await sendAndCollect(client, command, {
    timeoutMs,
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
  let hasLyrics = menuButtons.some(text => /متن\s*آهنگ/u.test(clean(text)));
  const hasArtistPage = Boolean(
    findArtistButtonFor(menuMessages, candidate?.artist || '')
  );
  const moreButton = menuButtons.find(text => /بیشتر/u.test(clean(text))) || null;

  let hasCover = false;
  let hasMetadata = false;
  if (moreButton) {
    try {
      const moreMessages = await openMoreMenuFromSurface(
        client,
        menuMessages,
        {
          timeoutMs: Math.min(config.searchTimeoutMs, 3000),
          capability: 'inspect_track',
        }
      );
      const moreButtons = buttonsFromMessages(moreMessages);
      hasCover = moreButtons.some(text => /کاور/u.test(clean(text)));
      hasMetadata = moreButtons.some(text => /بقیه\s*مشخصات|مشخصات/u.test(clean(text)));
      hasLyrics ||= moreButtons.some(text => /متن\s*آهنگ/u.test(clean(text)));
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

function isArtistNavigationSurface(message = {}, artist = '') {
  const messages = [message];
  const buttons = replyButtons(message);
  if (!buttons.length) return false;

  if (artistPickerItems(messages).length) return true;

  const hasArtistControls = buttons.some(text => {
    const value = clean(text);
    return /دانلود\s*همه|ترتیب|پربازدید|جدید|تازه|آلبوم|البوم|بیشتر|more/iu.test(value);
  });
  if (hasArtistControls) return true;

  const tracks = parseTracksFromMessages(messages, artist);
  if (!tracks.length) return false;

  // Plain search results can contain only Track rows and no deep-search
  // control. Accept Track-only layouts as an Artist page only when the message
  // body itself identifies the requested Artist; otherwise reuse a live Track
  // row and enter the Artist page through its explicit control.
  const body = normalize(messageText(message));
  const target = normalize(artist);
  return Boolean(
    target
    && (
      body === target
      || body === `${target} tracks`
      || body.includes(`آهنگ های ${target}`)
      || body.includes(`آثار ${target}`)
    )
  );
}


function buildArtistContextFromPage(
  messages = [],
  selectedArtist = '',
  {
    seedTrack = null,
    recoveredFromAlbum = false,
    relatedArtists = [],
    stateVersion = sourceStateVersion,
  } = {}
) {
  const allButtons = buttonsFromMessages(messages);
  const recentTracks = parseTracksFromMessages(messages, selectedArtist);
  const albumListing = inspectMeloBotAlbumListing(messages);
  const albumButton = albumListing.confirmed
    ? null
    : albumNavigationButton(messages);
  const orderButton = allButtons.find(text => /ترتیب/u.test(clean(text))) || null;
  const moreButton = allButtons.find(text => /بیشتر|more/iu.test(clean(text))) || null;
  const recentBulkHighButton = findButton(messages, text =>
    /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
  );
  const recentBulkNormalButton = findButton(messages, text =>
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
    sourceAfterId: maxMessageId(messages),
    sourceButtons: allButtons.slice(0, 30),
    sourceStateVersion: Number(stateVersion || sourceStateVersion),
    recentBulkHighButton,
    recentBulkNormalButton,
    relatedArtists,
    seedTrack: seedTrack || recentTracks[0] || null,
    recoveredFromAlbum,
  };
}

function isCurrentMeloBotSeed(seed = {}) {
  return Boolean(
    seed?.rawText
    && seed?.source !== 'ahangify'
    && Number(seed?.sourceStateVersion || -1) === Number(sourceStateVersion)
  );
}

async function openMeloBotArtistDirectBase(
  client,
  artist,
  { timeoutMs = 4500 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 4500);
  const first = await sendAndCollect(client, artist, {
    timeoutMs: Math.min(2500, remaining()),
    quietMs: 450,
    stopWhen: message => {
      const pickers = artistPickerItems([message]);
      if (pickers.some(item => normalize(item.name) === normalize(artist))) return true;
      if (isArtistNavigationSurface(message, artist) && !pickers.length) return true;

      // A plain search-result layout is still useful if it already exposes an
      // exact/compatible Track row for this artist; stop collecting and reuse
      // that live row instead of waiting for the Artist-search timeout.
      return parseTracksFromMessages([message], artist).some(track =>
        artistIdentityCompatible(artist, track.artist || '')
      );
    },
    waitForTarget: true,
    reconcileOnTimeout: true,
  });

  const directPage = first.messages?.find(message => {
    const pickers = artistPickerItems([message]);
    return !pickers.length && isArtistNavigationSurface(message, artist);
  });
  if (directPage) {
    return buildArtistContextFromPage(
      first.messages,
      artist,
      { stateVersion: first.stateVersion }
    );
  }

  const pickers = artistPickerItems(first.messages);
  const chosen = pickers.find(item => normalize(item.name) === normalize(artist)) || null;
  if (!chosen) {
    // Some MeloBot layouts return Track rows but no Artist picker. Reuse that
    // already-live row immediately instead of issuing the same Artist search a
    // second time and losing the only scripted/source surface.
    const freshSeed = parseTracksFromMessages(first.messages, artist)
      .find(track => artistIdentityCompatible(artist, track.artist || ''))
      || null;
    if (freshSeed && !remaining.expired()) {
      return openMeloBotArtistBase(
        client,
        {
          ...freshSeed,
          source: 'melobot',
          sourceStateVersion: first.stateVersion,
        },
        {
          timeoutMs: remaining(),
          allowArtistSearchFallback: false,
        }
      );
    }

    throw meloError(
      'MELOBOT_ARTIST_RESOLVE_FAILED',
      `MeloBot direct Artist search did not expose an exact picker: ${artist}`
    );
  }
  if (remaining.expired()) {
    throw new Error(`MeloBot direct Artist budget exhausted: ${artist}`);
  }

  const page = await sendAndCollect(client, chosen.rawText, {
    timeoutMs: remaining(),
    quietMs: 650,
    stopWhen: message => {
      const nested = artistPickerItems([message]);
      return !nested.length && isArtistNavigationSurface(message, chosen.name);
    },
    waitForTarget: true,
    reconcileOnTimeout: true,
  });
  const confirmed = page.messages?.some(message => {
    const nested = artistPickerItems([message]);
    return !nested.length && isArtistNavigationSurface(message, chosen.name);
  });
  if (!confirmed) {
    throw meloError(
      'MELOBOT_ARTIST_PAGE_TIMEOUT',
      `MeloBot direct Artist picker did not open a confirmed page: ${chosen.name}`
    );
  }

  return buildArtistContextFromPage(
    page.messages,
    chosen.name,
    {
      relatedArtists: pickers.map(item => item.name),
      stateVersion: page.stateVersion,
    }
  );
}

async function openMeloBotArtistBase(
  client,
  seedTrack,
  {
    timeoutMs = 9000,
    allowArtistSearchFallback = true,
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  let openedMenu = await openTrackMenuWithCandidate(
    client,
    seedTrack,
    {
      timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
      allowAlbumSurface: true,
    }
  );
  let menuMessages = openedMenu.messages;
  let effectiveSeed = openedMenu.candidate || seedTrack;
  let recoveredFromAlbum = false;

  let artistButton = findArtistButtonFor(
    menuMessages,
    effectiveSeed?.artist || seedTrack?.artist || ''
  );

  if (!artistButton) {
    const surface = inspectSelectedCandidateSurface(menuMessages, effectiveSeed);
    if (surface.kind === 'album' && surface.tracks.length) {
      // Some MeloBot search rows that look like a track are actually albums.
      // For artist navigation, use a real track button already visible on that
      // live album page instead of re-searching or timing out.
      const recoverySeed = {
        ...surface.tracks[0],
        source: 'melobot',
        sourceStateVersion,
      };
      openedMenu = await openTrackMenuWithCandidate(
        client,
        recoverySeed,
        {
          timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
          allowAlbumSurface: true,
        }
      );
      menuMessages = openedMenu.messages;
      effectiveSeed = openedMenu.candidate || recoverySeed;
      recoveredFromAlbum = true;
      artistButton = findArtistButtonFor(
        menuMessages,
        effectiveSeed?.artist || seedTrack?.artist || ''
      );
      if (artistButton) {
        console.log(
          '[fastpath] artist_recovery=album_track',
          effectiveSeed.artist,
          effectiveSeed.title
        );
      }
    }
  }

  let preOpenedArtistPage = null;
  if (!artistButton && allowArtistSearchFallback && !remaining.expired()) {
    // If the current Track surface has no Artist control, obtain a fresh seed
    // row for the requested artist and open that Track explicitly. Treating a
    // generic search-results surface as an Artist page caused the Farhad/Javad
    // bulk failures seen in production.
    try {
      const freshTracks = await searchMeloBot(client, effectiveSeed.artist, {
        timeoutMs: Math.min(2500, remaining()),
        maxRefinements: 2,
      });
      const freshSeed = freshTracks.find(track =>
        artistIdentityCompatible(effectiveSeed.artist, track.artist || '')
      ) || null;

      if (freshSeed && !remaining.expired()) {
        openedMenu = await openTrackMenuWithCandidate(
          client,
          freshSeed,
          {
            timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
            allowAlbumSurface: true,
          }
        );
        menuMessages = openedMenu.messages;
        effectiveSeed = openedMenu.candidate || freshSeed;
        artistButton = findArtistButtonFor(
          menuMessages,
          effectiveSeed.artist || seedTrack?.artist || ''
        );
      }
    } catch (err) {
      console.warn('[melobot artist fresh seed fallback]', effectiveSeed.artist, err.message);
    }
  }

  if (!artistButton && !preOpenedArtistPage) {
    console.warn(
      '[melobot artist menu surface]',
      effectiveSeed?.artist || seedTrack?.artist || 'unknown',
      describeMeloBotSurface(menuMessages),
      JSON.stringify({
        seedTitle: effectiveSeed?.title || seedTrack?.title || null,
        seedRawText: effectiveSeed?.rawText || seedTrack?.rawText || null,
        recoveredFromAlbum,
      })
    );
    throw new Error('MeloBot artist button not found.');
  }
  if (remaining.expired()) throw new Error('MeloBot artist navigation budget exhausted.');
  let artistPage = preOpenedArtistPage || await (async () => {
    await sleep(180);
    return sendAndCollect(client, artistButton, {
      timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
      quietMs: 650,
      stopWhen: message => isArtistNavigationSurface(message, effectiveSeed.artist),
      waitForTarget: true,
      reconcileOnTimeout: true,
    });
  })();

  if (
    !preOpenedArtistPage
    && !artistPage.messages?.some(message =>
      isArtistNavigationSurface(message, effectiveSeed.artist)
    )
  ) {
    throw meloError(
      'MELOBOT_ARTIST_PAGE_TIMEOUT',
      `MeloBot Artist page did not reach a confirmed surface: ${effectiveSeed.artist}`
    );
  }

  // Collaborative tracks can open an intermediate artist picker.
  const pickerButtons = artistPickerItems(artistPage.messages);

  let selectedArtist = effectiveSeed.artist;
  const relatedArtists = pickerButtons.map(item => item.name);

  if (pickerButtons.length) {
    const requested = normalize(effectiveSeed.artist);
    const requestedParts = artistIdentityParts(effectiveSeed.artist);

    const chosen = pickerButtons.find(item => normalize(item.name) === requested)
      || (
        requestedParts.length === 1
          ? pickerButtons.find(item => {
              const name = normalize(item.name);
              return name === requestedParts[0]
                || (
                  requestedParts[0].split(' ').length > 1
                  && name.split(' ').length > 1
                  && (
                    requestedParts[0].includes(name)
                    || name.includes(requestedParts[0])
                  )
                );
            })
          : null
      );

    if (!chosen) {
      throw meloError(
        'MELOBOT_ARTIST_RESOLVE_FAILED',
        `MeloBot Artist picker did not contain the requested artist: ${effectiveSeed.artist}`
      );
    }

    selectedArtist = chosen.name;

    if (remaining.expired()) throw new Error('MeloBot artist picker budget exhausted.');
    artistPage = await sendAndCollect(client, chosen.rawText, {
      timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
      quietMs: 750,
      stopWhen: message => isArtistNavigationSurface(message, chosen.name),
      waitForTarget: true,
      reconcileOnTimeout: true,
    });
    if (!artistPage.messages?.some(message =>
      isArtistNavigationSurface(message, chosen.name)
    )) {
      throw meloError(
        'MELOBOT_ARTIST_PAGE_TIMEOUT',
        `MeloBot Artist picker did not open a confirmed Artist page: ${chosen.name}`
      );
    }
  }

  return buildArtistContextFromPage(
    artistPage.messages,
    selectedArtist,
    {
      seedTrack: effectiveSeed,
      recoveredFromAlbum,
      relatedArtists,
      stateVersion: artistPage.stateVersion || sourceStateVersion,
    }
  );
}

async function finalizeMeloBotArtistFast(client, base, remaining) {
  let tracks = (base.recentTracks || []).slice(0, 10);
  let route = tracks.length ? 'artist_base' : 'artist_search_recovery';
  let liveStateValid = true;

  if (!tracks.length && !remaining.expired()) {
    try {
      const searched = await searchMeloBot(client, base.artist, {
        maxRefinements: 2,
        timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
      });
      const target = normalize(base.artist);
      const exact = searched
        .filter(track => normalize(track.artist) === target)
        .slice(0, 10);
      if (exact.length >= 2) {
        tracks = exact;
        liveStateValid = false;
      }
    } catch (err) {
      console.warn('[melobot fast artist recovery]', base.artist, err.message);
    }
  }

  if (!tracks.length) {
    throw new Error(`MeloBot artist page returned no usable tracks for: ${base.artist}`);
  }

  return {
    ...base,
    tracks,
    topTracks: [],
    recentTracks: (base.recentTracks || []).slice(0, 10),
    bulkHighButton: null,
    bulkNormalButton: null,
    liveAlbumButton: liveStateValid ? (base.albumButton || null) : null,
    liveAlbumList: liveStateValid ? (base.albumList || []) : [],
    liveAlbumListingConfirmed: liveStateValid
      ? Boolean(base.albumListingConfirmed)
      : false,
    liveAlbumListingConfirmedEmpty: liveStateValid
      ? Boolean(base.albumListingConfirmedEmpty)
      : false,
    liveAlbumDeclaredCount: liveStateValid
      ? (base.albumDeclaredCount ?? null)
      : null,
    liveAlbumNextButton: liveStateValid
      ? (base.albumNextButton || null)
      : null,
    liveAlbumSourceStateVersion: liveStateValid
      ? base.sourceStateVersion
      : null,
    fastArtistRoute: route,
  };
}

export async function openMeloBotArtistFast(
  client,
  seedTrack,
  { timeoutMs = 8000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 8000);
  const base = await openMeloBotArtistBase(
    client,
    seedTrack,
    { timeoutMs: remaining() }
  );
  return finalizeMeloBotArtistFast(client, base, remaining);
}

export async function openMeloBotArtistFastFresh(
  client,
  artist,
  preferredSeed = null,
  { timeoutMs = 8000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 8000);

  // A Track row from the currently visible MeloBot surface is already the
  // cheapest possible route. Only use the direct Artist picker when that row
  // is absent/stale; otherwise a speculative Artist query would invalidate it.
  if (isCurrentMeloBotSeed(preferredSeed)) {
    return openMeloBotArtistFast(
      client,
      preferredSeed,
      { timeoutMs: remaining() }
    );
  }

  try {
    const directBase = await openMeloBotArtistDirectBase(
      client,
      artist,
      { timeoutMs: Math.min(3600, remaining()) }
    );
    return await finalizeMeloBotArtistFast(client, directBase, remaining);
  } catch (err) {
    console.warn('[melobot direct artist fallback]', artist, err.message);
  }

  const seed = await findArtistSeed(
    client,
    artist,
    preferredSeed,
    { timeoutMs: remaining() }
  );
  if (remaining.expired()) {
    throw new Error(`MeloBot fast Artist open timed out for: ${artist}`);
  }
  return openMeloBotArtistFast(
    client,
    seed,
    { timeoutMs: remaining() }
  );
}

async function completeMeloBotArtistTop(client, base, remaining) {
  let topTracks = [];
  let bulkHighButton = null;
  let bulkNormalButton = null;
  let artistSourceStateVersion = base.sourceStateVersion;

  // The base artist page is the current source surface until we press a sort
  // control. Keep a separate live-surface snapshot so a later Albums click can
  // use it only while its source-state token is still current.
  let liveAlbumButton = base.albumButton || null;
  let liveAlbumList = base.albumList || [];
  let liveAlbumListingConfirmed = Boolean(base.albumListingConfirmed);
  let liveAlbumListingConfirmedEmpty = Boolean(base.albumListingConfirmedEmpty);
  let liveAlbumDeclaredCount = base.albumDeclaredCount ?? null;
  let liveAlbumNextButton = base.albumNextButton || null;
  let liveAlbumSourceStateVersion = base.sourceStateVersion;

  if (base.orderButton) {
    // Sending the sort command invalidates the base reply keyboard even if the
    // sort ultimately fails, so never expose stale album controls as "live".
    liveAlbumButton = null;
    liveAlbumList = [];
    liveAlbumListingConfirmed = false;
    liveAlbumListingConfirmedEmpty = false;
    liveAlbumDeclaredCount = null;
    liveAlbumNextButton = null;
    liveAlbumSourceStateVersion = null;

    try {
      let ordered = await sendAndCollect(client, base.orderButton, {
        timeoutMs: Math.min(ARTIST_SORT_TIMEOUT_MS, remaining()),
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
        if (popularityButton && !remaining.expired()) {
          ordered = await sendAndCollect(client, popularityButton, {
            timeoutMs: Math.min(ARTIST_SORT_TIMEOUT_MS, remaining()),
            quietMs: 650,
            stopWhen: message => replyButtons(message)
              .some(text => parseTrackButton(text, base.artist)),
          });
        }
      }

      topTracks = parseTracksFromMessages(ordered.messages, base.artist);
      artistSourceStateVersion = ordered.stateVersion;
      bulkHighButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
      );
      bulkNormalButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
      );

      const liveListing = inspectMeloBotAlbumListing(ordered.messages);
      liveAlbumButton = liveListing.confirmed
        ? null
        : albumNavigationButton(ordered.messages);
      liveAlbumList = liveListing.albums;
      liveAlbumListingConfirmed = liveListing.confirmed;
      liveAlbumListingConfirmedEmpty = liveListing.confirmedEmpty;
      liveAlbumDeclaredCount = liveListing.declaredCount;
      liveAlbumNextButton = liveListing.nextButton || null;
      liveAlbumSourceStateVersion = sourceStateVersion;
    } catch (err) {
      console.warn('[melobot artist sort]', err.message);
    }
  }

  if (!topTracks.length && !base.recentTracks.length && !remaining.expired()) {
    try {
      const fallback = await searchMeloBot(client, base.artist, {
        maxRefinements: 2,
        timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
      });
      const target = normalize(base.artist);
      const exactArtistTracks = fallback.filter(track =>
        normalize(track.artist) === target
      );
      const confidentTracks = exactArtistTracks.filter(track =>
        Number.isFinite(track.sourcePopularityCount)
        || /\s+x\s+\d+(?:\.\d+)?\s*[kKmMgG]?\s*$/u.test(track.rawText || '')
      );
      const recoveryTracks = confidentTracks.length
        ? confidentTracks
        : (exactArtistTracks.length >= 2 ? exactArtistTracks : []);
      const exactTracks = recoveryTracks.slice(0, 10);

      if (exactTracks.length) {
        topTracks = exactTracks;
        // The recovery search changed MeloBot state, so every reply-keyboard
        // control captured from the previous Artist page is stale. Keep the
        // recovered list as catalog identity only; a later bulk request must
        // either use cache or deliberately rebuild a live Artist page.
        bulkHighButton = null;
        bulkNormalButton = null;
        artistSourceStateVersion = sourceStateVersion;
        liveAlbumButton = null;
        liveAlbumList = [];
        liveAlbumListingConfirmed = false;
        liveAlbumListingConfirmedEmpty = false;
        liveAlbumDeclaredCount = null;
        liveAlbumNextButton = null;
        liveAlbumSourceStateVersion = null;
        console.log('[fastpath] artist_recovery=search_tracks', base.artist, exactTracks.length);
      }
    } catch (err) {
      console.warn('[melobot artist track recovery]', base.artist, err.message);
    }
  }

  if (!topTracks.length && !base.recentTracks.length) {
    throw new Error(`MeloBot artist page returned no usable tracks for: ${base.artist}`);
  }

  return {
    ...base,
    tracks: topTracks.length ? topTracks : base.recentTracks,
    topTracks,
    bulkHighButton,
    bulkNormalButton,
    sourceStateVersion: artistSourceStateVersion,
    liveAlbumButton,
    liveAlbumList,
    liveAlbumListingConfirmed,
    liveAlbumListingConfirmedEmpty,
    liveAlbumDeclaredCount,
    liveAlbumNextButton,
    liveAlbumSourceStateVersion,
  };
}

export async function openMeloBotArtist(
  client,
  seedTrack,
  { timeoutMs = 9000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  const base = await openMeloBotArtistBase(
    client,
    seedTrack,
    { timeoutMs: remaining() }
  );
  return completeMeloBotArtistTop(client, base, remaining);
}

export async function resolveMeloBotArtistTrackList(
  client,
  artist,
  mode = 'top',
  preferredSeed = null,
  { timeoutMs = 8000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 8000);
  const wantedMode = mode === 'recent' ? 'recent' : 'top';

  let directBase = null;
  let seed = isCurrentMeloBotSeed(preferredSeed) ? preferredSeed : null;

  if (!seed) {
    try {
      directBase = await openMeloBotArtistDirectBase(
        client,
        artist,
        { timeoutMs: Math.min(3600, remaining()) }
      );
    } catch (err) {
      console.warn('[melobot artist list direct fallback]', artist, err.message);
    }
    seed = directBase?.seedTrack || null;
  }

  if (!directBase && !seed) {
    seed = await findArtistSeed(
      client,
      artist,
      preferredSeed,
      { timeoutMs: remaining() }
    );
  }

  if (wantedMode === 'top') {
    const context = directBase
      ? await completeMeloBotArtistTop(client, directBase, remaining)
      : await openMeloBotArtist(
          client,
          seed,
          { timeoutMs: remaining() }
        );
    let tracks = (context.topTracks || []).slice(0, 10);
    let route = 'artist_top';

    if (!tracks.length && !remaining.expired()) {
      try {
        const searched = await searchMeloBot(client, context.artist || artist, {
          maxRefinements: 2,
          timeoutMs: Math.min(ARTIST_NAV_TIMEOUT_MS, remaining()),
        });
        const target = normalize(context.artist || artist);
        tracks = searched
          .filter(track =>
            normalize(track.artist) === target
            && Number.isFinite(track.sourcePopularityCount)
          )
          .sort((a, b) =>
            Number(b.sourcePopularityCount || 0) - Number(a.sourcePopularityCount || 0)
          )
          .slice(0, 10);
        if (tracks.length) route = 'artist_search_popularity';
      } catch (err) {
        console.warn('[melobot top list]', artist, err.message);
      }
    }

    if (!tracks.length) {
      throw new Error(`MeloBot returned no top tracks for: ${context.artist || artist}`);
    }
    return {
      artist: context.artist || artist,
      mode: 'top',
      tracks,
      seed: context.seedTrack || seed,
      context: {
        ...context,
        topTracks: tracks,
        tracks,
      },
      route,
    };
  }

  const base = directBase || await openMeloBotArtistBase(
    client,
    seed,
    { timeoutMs: remaining() }
  );
  let tracks = (base.recentTracks || []).slice(0, 10);
  let recentBulkHighButton = base.recentBulkHighButton || null;
  let recentBulkNormalButton = base.recentBulkNormalButton || null;
  let recentSourceStateVersion = base.sourceStateVersion;
  let route = tracks.length ? 'artist_base_recent' : 'artist_sort_recent';

  if (!tracks.length && base.orderButton && !remaining.expired()) {
    try {
      const sorted = await sendAndCollect(client, base.orderButton, {
        timeoutMs: Math.min(ARTIST_SORT_TIMEOUT_MS, remaining()),
        quietMs: 650,
      });
      const directTracks = parseTracksFromMessages(sorted.messages, base.artist);
      const orderLooksRecent = /جدید|تازه|تاریخ|انتشار|new|recent/iu.test(
        clean(base.orderButton)
      );

      if (directTracks.length && orderLooksRecent) {
        tracks = directTracks.slice(0, 10);
        recentSourceStateVersion = sorted.stateVersion;
        recentBulkHighButton = findButton(sorted.messages, text =>
          /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
        );
        recentBulkNormalButton = findButton(sorted.messages, text =>
          /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
        );
        route = 'artist_sort_direct_recent';
      } else {
        const recentButton = findButton(sorted.messages, text => {
          const value = clean(text);
          if (/بازدید|محبوب|برتر|پر.?دانلود/iu.test(value)) return false;
          return /جدید|تازه|تاریخ|انتشار|new|recent/iu.test(value);
        });

        if (recentButton && !remaining.expired()) {
          const recentPage = await sendAndCollect(client, recentButton, {
            timeoutMs: Math.min(ARTIST_SORT_TIMEOUT_MS, remaining()),
            quietMs: 650,
            stopWhen: message => replyButtons(message)
              .some(text => Boolean(parseTrackButton(text, base.artist))),
          });
          tracks = parseTracksFromMessages(recentPage.messages, base.artist).slice(0, 10);
          recentSourceStateVersion = recentPage.stateVersion;
          recentBulkHighButton = findButton(recentPage.messages, text =>
            /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
          );
          recentBulkNormalButton = findButton(recentPage.messages, text =>
            /دانلود همه/u.test(clean(text)) && /معمولی/u.test(clean(text))
          );
          route = 'artist_sort_button_recent';
        }
      }
    } catch (err) {
      console.warn('[melobot recent list]', artist, err.message);
    }
  }

  if (!tracks.length) {
    throw new Error(`MeloBot returned no recent tracks for: ${base.artist || artist}`);
  }

  return {
    artist: base.artist || artist,
    mode: 'recent',
    tracks,
    seed: base.seedTrack || seed,
    context: {
      ...base,
      recentTracks: tracks,
      recentBulkHighButton,
      recentBulkNormalButton,
      sourceStateVersion: recentSourceStateVersion,
    },
    route,
  };
}

export async function prepareMeloBotBulkTopTracks(
  client,
  artist,
  preferredSeed = null,
  { timeoutMs = 7000 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 7000);
  let context = null;

  if (isCurrentMeloBotSeed(preferredSeed)) {
    context = await openMeloBotArtist(
      client,
      preferredSeed,
      { timeoutMs: remaining() }
    );
  } else {
    try {
      const directBase = await openMeloBotArtistDirectBase(
        client,
        artist,
        { timeoutMs: Math.min(3400, remaining()) }
      );
      context = await completeMeloBotArtistTop(client, directBase, remaining);
    } catch (err) {
      console.warn('[melobot bulk top direct fallback]', artist, err.message);
    }
  }

  if (!context) {
    const seed = await findArtistSeed(
      client,
      artist,
      preferredSeed,
      { timeoutMs: remaining() }
    );
    context = await openMeloBotArtist(
      client,
      seed,
      { timeoutMs: remaining() }
    );
  }

  if (!context.bulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found on the sorted artist page.');
  }
  return context;
}

export async function prepareMeloBotBulkRecentTracks(
  client,
  artist,
  preferredSeed = null,
  { timeoutMs = 6500 } = {}
) {
  const remaining = sourceBudget(timeoutMs, 6500);
  let context = null;

  if (isCurrentMeloBotSeed(preferredSeed)) {
    context = await openMeloBotArtistBase(
      client,
      preferredSeed,
      { timeoutMs: remaining() }
    );
  } else {
    try {
      context = await openMeloBotArtistDirectBase(
        client,
        artist,
        { timeoutMs: Math.min(3400, remaining()) }
      );
    } catch (err) {
      console.warn('[melobot bulk recent direct fallback]', artist, err.message);
    }
  }

  if (!context) {
    const seed = await findArtistSeed(
      client,
      artist,
      preferredSeed,
      { timeoutMs: remaining() }
    );
    context = await openMeloBotArtistBase(
      client,
      seed,
      { timeoutMs: remaining() }
    );
  }

  if (!context.recentBulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found on the newest artist page.');
  }
  return context;
}

export async function openMeloBotAlbumContext(
  client,
  artist,
  album,
  { timeoutMs = config.searchTimeoutMs } = {}
) {
  const page = await sendAndCollect(client, album.rawText, {
    timeoutMs,
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
  const context = await openMeloBotAlbumRobustByTitle(
    client,
    artist,
    albumTitle,
    {
      timeoutMs: 4500,
      maxPages: 8,
    }
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
  expectedStateVersion = null,
} = {}) {
  if (!button) throw new Error(`MeloBot ${label} bulk button not found.`);
  if (
    expectedStateVersion !== null
    && expectedStateVersion !== undefined
    && Number(expectedStateVersion) !== Number(sourceStateVersion)
  ) {
    throw meloError(
      'MELOBOT_BULK_SURFACE_STALE',
      `MeloBot ${label} bulk surface is stale.`
    );
  }

  const adaptiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : Math.min(
        Math.max(
          Number(config.downloadTimeoutMs || 30000),
          expectedCount > 0 ? 2200 + expectedCount * 550 : 5000
        ),
        30000
      );

  // Fail quickly when a stale/wrong bulk button produces no audio at all.
  // Once the first audio arrives, keep listening for the remaining files using
  // the inbox buffer so large valid albums still get their full delivery time.
  const startedAt = Date.now();
  const firstAudioTimeoutMs = Math.min(
    adaptiveTimeoutMs,
    expectedCount > 0 ? 3200 : 4000
  );
  const first = await sendAndCollect(client, button, {
    timeoutMs: firstAudioTimeoutMs,
    quietMs: 450,
    stopWhen: message => isAudioMessage(message),
    waitForTarget: true,
    reconcileOnTimeout: true,
  });

  const firstAudios = first.messages.filter(isAudioMessage);
  if (!firstAudios.length) {
    const response = first.messages.map(messageText).filter(Boolean).join('\n');
    throw meloError(
      'MELOBOT_BULK_DELIVERY_TIMEOUT',
      `MeloBot ${label} bulk HQ did not deliver audio (no initial audio). ${response.slice(0, 350)}`
    );
  }

  let messages = [...first.messages];
  const remainingCount = expectedCount > 0
    ? Math.max(0, expectedCount - firstAudios.length)
    : null;
  const elapsed = Date.now() - startedAt;
  const remainingMs = Math.max(0, adaptiveTimeoutMs - elapsed);

  if (remainingMs > 250 && (remainingCount === null || remainingCount > 0)) {
    const afterId = maxMessageId(first.messages);
    const late = await collectNewMessages(
      client,
      config.melobotUsername,
      afterId,
      {
        timeoutMs: remainingMs,
        quietMs: expectedCount > 0 ? 700 : 900,
        stopWhenBatch: remainingCount
          ? batch => batch.filter(isAudioMessage).length >= remainingCount
          : undefined,
        waitForTarget: Boolean(remainingCount),
        reconcileOnTimeout: true,
      }
    );
    messages = mergeMessageSets(messages, late.messages || []);
  }

  const audios = messages.filter(isAudioMessage).map(audioMeta);
  return {
    source: 'melobot',
    audioItems: audios,
  };
}

export async function downloadMeloBotTopTracks(
  client,
  artistContext,
  { timeoutMs = 12000 } = {}
) {
  return downloadMeloBotBulkTracks(client, {
    button: artistContext.bulkHighButton,
    label: 'top tracks',
    expectedCount: artistContext.topTracks?.length || artistContext.tracks?.length || 0,
    timeoutMs,
    expectedStateVersion: artistContext.sourceStateVersion,
  });
}

export async function downloadMeloBotRecentTracks(
  client,
  artistContext,
  { timeoutMs = 12000 } = {}
) {
  return downloadMeloBotBulkTracks(client, {
    button: artistContext.recentBulkHighButton,
    label: 'recent tracks',
    expectedCount: artistContext.recentTracks?.length || artistContext.tracks?.length || 0,
    timeoutMs,
    expectedStateVersion: artistContext.sourceStateVersion,
  });
}

export async function downloadMeloBotAlbumTracks(
  client,
  albumContext,
  { timeoutMs = 12000 } = {}
) {
  return downloadMeloBotBulkTracks(client, {
    button: albumContext.bulkHighButton,
    label: `album ${albumContext.album?.title || ''}`,
    expectedCount: albumContext.tracks?.length || 0,
    timeoutMs,
    expectedStateVersion: albumContext.sourceStateVersion,
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
  const exact = items.find(item => normalize(item.name) === target);
  if (exact) return exact;

  const parts = artistIdentityParts(requested);
  if (parts.length > 1) return null;

  if (parts.length === 1) {
    const wanted = parts[0];
    const wantedTokens = wanted.split(' ').filter(Boolean);
    if (wantedTokens.length > 1) {
      return items.find(item => {
        const name = normalize(item.name);
        const nameTokens = name.split(' ').filter(Boolean);
        return name
          && nameTokens.length > 1
          && (name.includes(wanted) || wanted.includes(name));
      }) || null;
    }
  }
  return requested ? null : (items[0] || null);
}

async function openMeloBotAlbumListingDirect(client, artistQuery, {
  timeoutMs = Math.min(config.searchTimeoutMs, 6000),
  allowSeedFallback = true,
} = {}) {
  const remaining = sourceBudget(timeoutMs, 6000);
  const first = await sendAndCollect(client, artistQuery, {
    timeoutMs: remaining(),
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
        timeoutMs: remaining(),
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
        timeoutMs: remaining(),
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

  if (!allowSeedFallback) {
    throw new Error(
      `MeloBot direct album surface was not found for: ${artistQuery}. `
      + describeMeloBotSurface(messages)
    );
  }

  // Search-only layouts may require one or more suggestion selections before
  // a real track exists. Use that live track to enter the artist page, while
  // preserving the album-page state returned by getInitialMeloBotAlbumListing.
  if (remaining.expired()) throw new Error(`MeloBot direct album route timed out for: ${artistQuery}`);

  const seeds = await searchMeloBot(client, artistQuery, { maxRefinements: 3, timeoutMs: remaining() });
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

  if (remaining.expired()) throw new Error(`MeloBot direct album route timed out for: ${artistQuery}`);
  const artistContext = await openMeloBotArtistBase(client, seed, {
    timeoutMs: remaining(),
    allowArtistSearchFallback: false,
  });
  const initial = await getInitialMeloBotAlbumListing(client, artistContext, { timeoutMs: remaining() });
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
  timeoutMs = Math.min(config.searchTimeoutMs, 6000),
} = {}) {
  const remaining = sourceBudget(timeoutMs, 6000);
  const artistQuery = stripAlbumIntent(query);
  if (!artistQuery) return { artist: '', albums: [] };

  const first = await sendAndCollect(client, artistQuery, {
    timeoutMs: remaining(),
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
        timeoutMs: remaining(),
        quietMs: 750,
      });
      contextMessages = selected.messages;
      listing = inspectMeloBotAlbumListing(contextMessages);
    }
  }

  if (listing.confirmed) {
    const resolved = listing.complete || !listing.nextButton
      ? listing
      : await collectMeloBotAlbumPages(client, listing, { maxAlbums, timeoutMs: remaining() });
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
      timeoutMs: remaining(),
      quietMs: 750,
    });
    listing = inspectMeloBotAlbumListing(page.messages);
    if (listing.confirmed) {
      const resolved = listing.complete || !listing.nextButton
        ? listing
        : await collectMeloBotAlbumPages(client, listing, { maxAlbums, timeoutMs: remaining() });
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
      seedTracks = await searchMeloBot(client, artistQuery, { maxRefinements: 3, timeoutMs: remaining() });
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
    const artistContext = await openMeloBotArtistBase(client, seed, {
      timeoutMs: remaining(),
      allowArtistSearchFallback: false,
    });
    const resolved = await resolveMeloBotAlbums(
      client,
      artistContext,
      { allowEmpty: true, maxAlbums, timeoutMs: remaining() }
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
      const artistContext = await openMeloBotArtistBase(client, seed, {
        allowArtistSearchFallback: false,
      });
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

async function getInitialMeloBotAlbumListing(
  client,
  artistContext,
  { timeoutMs = Math.min(config.searchTimeoutMs, 6000) } = {}
) {
  const remaining = sourceBudget(timeoutMs, 6000);
  const embedded = embeddedMeloBotAlbumListing(artistContext);
  if (embedded) {
    return { listing: embedded, route: 'embedded' };
  }

  const albumControl = clean(artistContext?.albumButton || '');
  if (albumControl) {
    const page = await sendAndCollect(client, albumControl, {
      timeoutMs: remaining(),
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

  const probed = await probeMeloBotAlbumSurface(client, artistContext, { timeoutMs: remaining() });
  if (probed.listing?.confirmed) {
    return { listing: probed.listing, route: probed.route };
  }

  throw new Error(
    `MeloBot album listing is not available or was not confirmed (route=${probed.route}).`
  );
}

async function probeMeloBotAlbumSurface(
  client,
  artistContext,
  { timeoutMs = Math.min(config.searchTimeoutMs, 6000) } = {}
) {
  const remaining = sourceBudget(timeoutMs, 6000);
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
      { timeoutMs: Math.min(3600, remaining()), quietMs: 500 }
    );
    messages = mergeMessageSets(messages, late);
    listing = inspectMeloBotAlbumListing(messages);

    if (listing.confirmed) return { listing, messages, route: 'late_artist_page' };

    const lateNav = albumNavigationButton(messages);
    if (lateNav) {
      const page = await sendAndCollect(client, lateNav, {
        timeoutMs: remaining(),
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
      timeoutMs: remaining(),
      quietMs: 750,
    });
    messages = mergeMessageSets(messages, more.messages);
    listing = inspectMeloBotAlbumListing(more.messages);
    if (listing.confirmed) return { listing, messages: more.messages, route: 'artist_more_listing' };

    const navButton = albumNavigationButton(more.messages);
    if (navButton) {
      const page = await sendAndCollect(client, navButton, {
        timeoutMs: remaining(),
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


export async function openMeloBotAlbumDirectByTitle(
  client,
  artist,
  albumTitle,
  {
    maxPages = 12,
    timeoutMs = 6000,
    allowSeedFallback = false,
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 6000);
  const direct = await openMeloBotAlbumListingDirect(
    client,
    artist,
    { timeoutMs: remaining(), allowSeedFallback }
  );

  let state = direct.listing;
  const resolvedArtist = direct.artist || artist;
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
        target,
        { timeoutMs: remaining() }
      );
      return {
        ...context,
        seed: direct.seed || null,
        route: 'direct_title',
      };
    }

    if (!state?.nextButton || remaining.expired()) break;

    const page = await sendAndCollect(client, state.nextButton, {
      timeoutMs: remaining(),
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

  throw new Error(`MeloBot direct album title was not found: ${albumTitle}`);
}
export async function openMeloBotAlbumRobustByTitle(
  client,
  artist,
  albumTitle,
  {
    album = null,
    timeoutMs = 4500,
    totalTimeoutMs = 10000,
    maxPages = 12,
  } = {}
) {
  const errors = [];
  const targetTitle = normalize(albumTitle);
  const remaining = sourceBudget(totalTimeoutMs, 10000);
  const stepTimeout = (cap = timeoutMs) =>
    Math.min(Math.max(450, Number(cap || timeoutMs)), remaining());

  if (
    album?.rawText
    && Number(album?.sourceStateVersion || -1) === Number(sourceStateVersion)
  ) {
    try {
      const context = await openMeloBotAlbumContext(
        client,
        artist,
        album,
        { timeoutMs: stepTimeout() }
      );
      return { ...context, route: 'live_album_row' };
    } catch (err) {
      errors.push(`live_row=${err.message}`);
    }
  }

  try {
    return await openMeloBotAlbumDirectByTitle(
      client,
      artist,
      albumTitle,
      {
        timeoutMs: stepTimeout(),
        maxPages,
        allowSeedFallback: true,
      }
    );
  } catch (err) {
    errors.push(`direct=${err.message}`);
  }

  if (remaining.expired()) {
    throw new Error(`MeloBot robust album open timed out: ${artist} — ${albumTitle}`);
  }

  const exactQueries = [
    [artist, albumTitle].filter(Boolean).join(' '),
    albumTitle,
  ].filter(Boolean);

  for (const query of [...new Set(exactQueries)]) {
    if (remaining.expired()) break;
    try {
      const typed = await classifyMeloBotTypedSearchExact(
        client,
        query,
        await searchMeloBotTyped(client, query, {
          maxRefinements: 2,
          timeoutMs: stepTimeout(),
        })
      );

      const candidate = (typed.albums || []).find(item =>
        normalize(item.title) === targetTitle
      );
      if (candidate?.rawText) {
        const resolvedArtist = candidate.artist || artist;
        const context = await openMeloBotAlbumContext(
          client,
          resolvedArtist,
          candidate,
          { timeoutMs: stepTimeout() }
        );
        return {
          ...context,
          route: 'exact_album_search',
        };
      }
    } catch (err) {
      errors.push(`query:${query}=${err.message}`);
    }
  }

  const artistParts = clean(artist)
    .split(/\s*(?:&|\bx\b|,|feat\.?|ft\.?)\s*/iu)
    .map(part => clean(part))
    .filter(Boolean);

  for (const part of [...new Set(artistParts)]) {
    if (remaining.expired()) break;
    if (normalize(part) === normalize(artist)) continue;
    try {
      const opened = await openMeloBotAlbumDirectByTitle(
        client,
        part,
        albumTitle,
        {
          timeoutMs: stepTimeout(Math.min(timeoutMs, 3500)),
          maxPages,
          allowSeedFallback: true,
        }
      );
      return {
        ...opened,
        route: 'artist_component_direct',
      };
    } catch (err) {
      errors.push(`artist:${part}=${err.message}`);
    }
  }

  throw new Error(
    `MeloBot robust album open failed: ${artist} — ${albumTitle}. ${errors.slice(0, 4).join(' | ')}`
  );
}


export async function resolveMeloBotAlbums(
  client,
  artistContext,
  {
    allowEmpty = false,
    maxAlbums = 60,
    timeoutMs = Math.min(config.searchTimeoutMs, 6000),
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 6000);
  const initial = await getInitialMeloBotAlbumListing(
    client,
    artistContext,
    { timeoutMs: remaining() }
  );
  const listing = initial.listing;

  const resolved = listing.complete || !listing.nextButton
    ? listing
    : await collectMeloBotAlbumPages(
        client,
        listing,
        { maxAlbums, timeoutMs: remaining() }
      );

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

export async function resolveMeloBotAlbumsFromLiveArtistContext(
  client,
  artistContext,
  {
    allowEmpty = true,
    maxAlbums = 60,
    timeoutMs = Math.min(config.searchTimeoutMs, 6000),
  } = {}
) {
  if (
    Number(artistContext?.liveAlbumSourceStateVersion || -1)
    !== Number(sourceStateVersion)
  ) {
    throw new Error('MeloBot live artist album surface is stale.');
  }

  const hasLiveSurface = Boolean(
    artistContext?.liveAlbumListingConfirmed
    || artistContext?.liveAlbumButton
  );
  if (!hasLiveSurface) {
    throw new Error('MeloBot current artist surface has no album control.');
  }

  const liveContext = {
    artist: artistContext.artist,
    albumButton: artistContext.liveAlbumButton || null,
    albumList: artistContext.liveAlbumList || [],
    albumListingConfirmed: Boolean(artistContext.liveAlbumListingConfirmed),
    albumListingConfirmedEmpty: Boolean(
      artistContext.liveAlbumListingConfirmedEmpty
    ),
    albumDeclaredCount: artistContext.liveAlbumDeclaredCount ?? null,
    albumNextButton: artistContext.liveAlbumNextButton || null,
  };

  const resolved = await resolveMeloBotAlbums(
    client,
    liveContext,
    { allowEmpty, maxAlbums, timeoutMs }
  );

  return {
    artist: artistContext.artist,
    seed: null,
    artistContext,
    ...resolved,
    source: `live_artist_surface:${resolved.source || 'unknown'}`,
  };
}

function normalizeDirectAlbumResolution(direct, artist, preferredSeed = null) {
  const listing = direct.listing;
  return {
    artist: direct.artist || artist,
    seed: direct.seed || preferredSeed || null,
    artistContext: direct.artistContext || null,
    albums: listing.albums || [],
    complete: Boolean(listing.complete),
    confirmedEmpty: Boolean(listing.confirmedEmpty),
    confirmed: Boolean(
      listing.confirmed || listing.albums?.length || listing.confirmedEmpty
    ),
    declaredCount: listing.declaredCount ?? null,
    source: `direct_first:${direct.route || 'unknown'}`,
    sourceStateVersion,
    sourceStateSinglePage: !listing.nextButton,
  };
}

export async function resolveMeloBotArtistAlbumsDirectFirst(
  client,
  artist,
  preferredSeed = null,
  {
    allowEmpty = true,
    maxAlbums = 60,
    directTimeoutMs = 6000,
  } = {}
) {
  let primaryError = null;
  let directError = null;
  const seedLooksTrusted = Boolean(
    preferredSeed?.rawText
    && preferredSeed?.artist
    && !preferredSeed?.artistInferred
    && normalize(preferredSeed.artist) === normalize(artist)
  );

  // A concrete source-backed Track is a safer way to establish Artist state
  // than typing a bare Artist name into MeloBot's stateful reply-keyboard flow.
  if (seedLooksTrusted) {
    try {
      const primary = await resolveMeloBotArtistAlbums(
        client,
        artist,
        preferredSeed,
        {
          allowEmpty,
          maxAlbums,
          skipDirectFallback: true,
          timeoutMs: Math.min(4500, Math.max(1800, Number(directTimeoutMs || 4500))),
        }
      );
      return {
        ...primary,
        source: `seed_first:${primary.source || 'primary'}`,
      };
    } catch (err) {
      primaryError = err;
      console.warn('[melobot album seed-first]', artist, err.message);
    }
  }

  try {
    const direct = await openMeloBotAlbumListingDirect(
      client,
      artist,
      {
        timeoutMs: Math.max(1200, Number(directTimeoutMs || 6000)),
        allowSeedFallback: true,
      }
    );

    const listing = direct.listing.complete || !direct.listing.nextButton
      ? direct.listing
      : await collectMeloBotAlbumPages(
          client,
          direct.listing,
          { maxAlbums }
        );

    const normalized = normalizeDirectAlbumResolution(
      { ...direct, listing },
      artist,
      preferredSeed
    );

    if (!normalized.albums.length && !normalized.confirmedEmpty && !allowEmpty) {
      throw new Error('Direct-first album route returned no usable albums.');
    }
    if (
      normalized.albums.length
      && !normalized.complete
      && !normalized.confirmedEmpty
    ) {
      throw new Error('Direct-first album surface was only a partial search suggestion.');
    }

    return normalized;
  } catch (err) {
    directError = err;
    console.warn('[melobot album direct-first]', artist, err.message);
  }

  if (!seedLooksTrusted) {
    try {
      const primary = await resolveMeloBotArtistAlbums(
        client,
        artist,
        preferredSeed,
        {
          allowEmpty,
          maxAlbums,
          skipDirectFallback: true,
        }
      );
      return {
        ...primary,
        source: `primary_after_direct:${primary.source || 'unknown'}`,
      };
    } catch (err) {
      primaryError = err;
    }
  }

  throw new Error(
    `MeloBot album resolution failed. seed=${primaryError?.message || 'not_used'}; direct=${directError?.message || 'unknown'}`
  );
}

export async function resolveMeloBotArtistAlbums(
  client,
  artist,
  preferredSeed = null,
  {
    allowEmpty = true,
    maxAlbums = 60,
    skipDirectFallback = false,
    timeoutMs = Math.min(config.searchTimeoutMs, 10000),
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 10000);
  let primaryError = null;
  const circuitRemainingMs = albumPrimaryCircuitRemainingMs(artist);

  if (!circuitRemainingMs) {
    try {
      const seed = await findArtistSeed(
        client,
        artist,
        preferredSeed,
        { timeoutMs: remaining() }
      );
      const artistContext = await openMeloBotArtistBase(
        client,
        seed,
        {
          timeoutMs: remaining(),
          allowArtistSearchFallback: false,
        }
      );

      // MeloBot uses a stateful reply keyboard. Resolve albums immediately from
      // the base artist page before sorting/top-track navigation changes that state.
      const resolved = await resolveMeloBotAlbums(
        client,
        artistContext,
        { allowEmpty, maxAlbums, timeoutMs: remaining() }
      );

      clearAlbumPrimaryFailure(artistContext.artist || artist);
      return {
        artist: artistContext.artist,
        seed,
        artistContext,
        ...resolved,
      };
    } catch (err) {
      primaryError = err;
      markAlbumPrimaryFailure(artist);
      console.warn('[melobot album primary route]', artist, err.message);
    }
  } else {
    primaryError = new Error(`primary route circuit open for ${circuitRemainingMs}ms`);
    console.log('[melobot album primary circuit]', artist, circuitRemainingMs);
  }

  if (skipDirectFallback) {
    throw primaryError || new Error('MeloBot primary album route failed.');
  }

  try {
    if (remaining.expired()) {
      throw new Error('MeloBot artist album resolution budget exhausted.');
    }
    const direct = await discoverMeloBotAlbumsByArtistQuery(
      client,
      `album ${artist}`,
      { maxAlbums, timeoutMs: remaining() }
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

  const circuitRemainingMs = albumPrimaryCircuitRemainingMs(artist);

  if (!circuitRemainingMs) {
    try {
      seed = await findArtistSeed(client, artist, preferredSeed);
      const artistContext = await openMeloBotArtistBase(client, seed, {
        allowArtistSearchFallback: false,
      });
      resolvedArtist = artistContext.artist;
      const initial = await getInitialMeloBotAlbumListing(client, artistContext);
      state = initial.listing;
      clearAlbumPrimaryFailure(resolvedArtist || artist);
    } catch (seedRouteError) {
      markAlbumPrimaryFailure(artist);
      console.warn('[melobot album open primary]', artist, seedRouteError.message);
    }
  } else {
    console.log('[melobot album open circuit]', artist, circuitRemainingMs);
  }

  if (!state) {
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

export async function listMeloBotAlbums(
  client,
  artistContext,
  {
    allowEmpty = false,
    timeoutMs = Math.min(config.searchTimeoutMs, 6000),
  } = {}
) {
  const resolved = await resolveMeloBotAlbums(
    client,
    artistContext,
    { allowEmpty, timeoutMs }
  );
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

async function openMeloBotDailyPlaylists(
  client,
  { timeoutMs = Math.min(config.searchTimeoutMs, 9000) } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  const index = await sendAndCollect(client, '/playlists', {
    timeoutMs: remaining(),
    quietMs: 650,
  });

  const dailyButton = findButton(index.messages, text =>
    /پلی\s*لیست.*روزانه|پلیلیست.*روزانه/u.test(clean(text))
  );
  if (!dailyButton) throw new Error('MeloBot daily playlists button was not found.');

  if (remaining.expired()) {
    throw new Error('MeloBot playlist-index budget exhausted.');
  }
  return sendAndCollect(client, dailyButton, {
    timeoutMs: remaining(),
    quietMs: 700,
  });
}

export async function listCuratedMeloBotPlaylists(
  client,
  {
    maxPlaylists = 5,
    timeoutMs = Math.min(config.searchTimeoutMs, 9000),
  } = {}
) {
  const page = await openMeloBotDailyPlaylists(client, { timeoutMs });
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

export async function openMeloBotCuratedPlaylist(
  client,
  playlist,
  { timeoutMs = Math.min(config.searchTimeoutMs, 9000) } = {}
) {
  const remaining = sourceBudget(timeoutMs, 9000);
  if (!playlist?.key) throw new Error('Curated playlist key is missing.');
  const rule = curatedPlaylistByKey(playlist.key);
  if (!rule) throw new Error(`Unknown curated playlist: ${playlist.key}`);

  const page = await openMeloBotDailyPlaylists(
    client,
    { timeoutMs: remaining() }
  );
  const liveButton = buttonsFromMessages(page.messages).find(text => rule.pattern.test(clean(text)));
  if (!liveButton) throw new Error(`MeloBot playlist is not available: ${playlist.label || playlist.key}`);

  if (remaining.expired()) {
    throw new Error(`MeloBot playlist budget exhausted: ${playlist.label || playlist.key}`);
  }
  const result = await sendAndCollect(client, liveButton, {
    timeoutMs: remaining(),
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

export async function discoverMeloBotPlaylists(
  client,
  {
    maxPlaylists = 5,
    timeoutMs = 12000,
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 12000);
  const playlists = await listCuratedMeloBotPlaylists(
    client,
    {
      maxPlaylists,
      timeoutMs: remaining(),
    }
  );
  const entries = [];
  const tracks = [];
  const artists = [];
  const seenTracks = new Set();
  const seenArtists = new Set();

  for (const playlist of playlists) {
    if (remaining.expired()) break;
    try {
      const opened = await openMeloBotCuratedPlaylist(
        client,
        playlist,
        { timeoutMs: remaining() }
      );
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

export async function discoverMeloBotHome(
  client,
  {
    maxSections = 3,
    timeoutMs = 12000,
  } = {}
) {
  const remaining = sourceBudget(timeoutMs, 12000);

  // Bootstrap only through buttons that actually exist on MeloBot's live
  // keyboard. One shared budget prevents an idle crawler that started just
  // before a user returns from holding the source lane for many sections.
  const openHome = async () => {
    if (remaining.expired()) {
      throw new Error('MeloBot home discovery budget exhausted.');
    }

    let page = await sendAndCollect(client, '/start', {
      timeoutMs: remaining(),
      quietMs: 650,
    });

    const homeButton = findButton(page.messages, text => /صفحه\s*اصلی/u.test(clean(text)));
    if (homeButton && !remaining.expired()) {
      try {
        page = await sendAndCollect(client, homeButton, {
          timeoutMs: remaining(),
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

  const openedSections = [];
  for (const sectionButton of sectionButtons) {
    if (remaining.expired()) break;
    try {
      await openHome();
      if (remaining.expired()) break;
      const section = await sendAndCollect(client, sectionButton, {
        timeoutMs: remaining(),
        quietMs: 650,
        stopWhen: message => replyButtons(message).some(text => Boolean(parseTrackButton(text))),
      });
      openedSections.push(sectionButton);
      absorb(section.messages);
    } catch (err) {
      console.warn('[melobot bootstrap section]', sectionButton, err.message);
    }
  }

  return { tracks, artists, sections: openedSections };
}
