import { config } from '../config.js';
import {
  collectNewMessages,
  isAudioMessage,
  latestMessageId,
  messageText,
} from '../mtproto.js';

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
];

function clean(value = '') {
  return String(value)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value = '') {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export function parseTrackButton(rawText, fallbackArtist = '') {
  const original = clean(rawText);
  if (!original || isControl(original) || looksLikeAlbumButton(original)) return null;
  if (/^[🗣🎤🎙]/u.test(original)) return null;

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
    };
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
  };
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
  quietMs = 1600,
  stopWhen,
} = {}) {
  const peer = config.melobotUsername;
  const afterId = await latestMessageId(client, peer);
  await client.sendMessage(peer, { message: text });
  return collectNewMessages(client, peer, afterId, {
    timeoutMs,
    quietMs,
    stopWhen,
  });
}

export async function searchMeloBot(client, query) {
  const result = await sendAndCollect(client, query, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1800,
    stopWhen: m => replyButtons(m).some(text => parseTrackButton(text)),
  });

  const tracks = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(result.messages)) {
    const track = parseTrackButton(rawText);
    if (!track) continue;
    const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }

  if (!tracks.length) {
    const response = result.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`MeloBot search returned no usable tracks. ${response.slice(0, 350)}`);
  }

  return tracks;
}

export async function openMeloBotArtistFresh(client, artist, preferredSeed = null) {
  let seed = preferredSeed;

  try {
    const results = await searchMeloBot(client, artist);
    const target = normalize(artist);
    seed = results.find(track => normalize(track.artist) === target)
      || results.find(track => normalize(track.artist).includes(target) || target.includes(normalize(track.artist)))
      || seed;
  } catch (err) {
    console.warn('[melobot fresh artist search]', artist, err.message);
  }

  if (!seed) throw new Error(`No usable MeloBot seed track found for artist: ${artist}`);
  return openMeloBotArtist(client, seed);
}

async function openTrackMenu(client, candidate) {
  const selected = await sendAndCollect(client, candidate.rawText, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1500,
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
    quietMs: 1600,
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
    quietMs: 1800,
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
    quietMs: 1600,
  });
  return more.messages;
}

export async function getMeloBotLyrics(client, candidate) {
  const menuMessages = await openTrackMenu(client, candidate);
  const lyricsButton = findButton(menuMessages, text => /متن\s*آهنگ/u.test(clean(text)));
  if (!lyricsButton) return { available: false, text: '' };

  const result = await sendAndCollect(client, lyricsButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1800,
  });

  const raw = result.messages.map(messageText).filter(Boolean).join('\n\n').trim();
  if (!raw) return { available: false, text: '' };

  const artistNorm = normalize(candidate.artist);
  const titleNorm = normalize(candidate.title);
  const lines = raw.split(/\n/).map(line => line.trim()).filter(Boolean);
  const kept = lines.filter(line => {
    const n = normalize(line);
    if (!n) return false;
    if (n === artistNorm || n === titleNorm) return false;
    if (line.startsWith('#')) return false;
    if (/^@?melobot$/iu.test(line)) return false;
    if (/^ID\s*@?melobot$/iu.test(line)) return false;
    if (/دانلود\s*آهنگ/u.test(line)) return false;
    return true;
  });

  const text = kept.join('\n').trim();
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
    quietMs: 1800,
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
    quietMs: 1800,
    stopWhen: photoMessage,
  });

  const photo = result.messages.find(photoMessage);
  return photo ? { source: 'melobot', photoMessage: photo } : null;
}

export async function discoverMeloBotFeed(client, command, { contentOrigin = 'unknown' } = {}) {
  const result = await sendAndCollect(client, command, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 2200,
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
        quietMs: 1400,
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

export async function openMeloBotArtist(client, seedTrack) {
  const menuMessages = await openTrackMenu(client, seedTrack);
  const artistButton = findButton(menuMessages, text =>
    text.includes('خواننده') && !text.includes('پیشنهاد')
  );
  if (!artistButton) throw new Error('MeloBot artist button not found.');

  let artistPage = await sendAndCollect(client, artistButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1800,
  });

  // Collaborative tracks can open an intermediate "خواننده های آهنگ" picker.
  // Choose a real artist button from the live keyboard before parsing the artist page.
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

    let chosen = pickerButtons.find(item => normalize(item.name) === requested)
      || pickerButtons.find(item => requestedParts.includes(normalize(item.name)))
      || pickerButtons.find(item => requested.includes(normalize(item.name)))
      || pickerButtons[0];

    selectedArtist = chosen.name;

    artistPage = await sendAndCollect(client, chosen.rawText, {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 1800,
      stopWhen: message => {
        const buttons = replyButtons(message);
        return buttons.some(text => parseTrackButton(text, selectedArtist)) ||
          buttons.some(text => /^💿(?:\s|$)/u.test(clean(text))) ||
          buttons.some(text => /ترتیب/u.test(clean(text)));
      },
    });
  }

  const allButtons = buttonsFromMessages(artistPage.messages);
  const recentTracks = parseTracksFromMessages(artistPage.messages, selectedArtist);

  const albumButton =
    allButtons.find(text => /^💿\s*$/u.test(clean(text))) ||
    allButtons.find(text => /^💿(?:\s|$)/u.test(clean(text))) ||
    allButtons.find(text => /آلبوم/u.test(text)) ||
    null;

  const orderButton = allButtons.find(text => /ترتیب/u.test(clean(text))) || null;
  let topTracks = [];
  let bulkHighButton = null;

  if (orderButton) {
    try {
      let ordered = await sendAndCollect(client, orderButton, {
        timeoutMs: config.searchTimeoutMs,
        quietMs: 2200,
        stopWhen: message => {
          const buttons = replyButtons(message);
          const hasTracks = buttons.some(text => parseTrackButton(text, selectedArtist));
          const hasBulkHq = buttons.some(text =>
            /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
          );
          return hasTracks && hasBulkHq;
        },
      });

      if (!parseTracksFromMessages(ordered.messages, selectedArtist).length) {
        const popularityButton = findButton(ordered.messages, text =>
          /بازدید|محبوب|برتر|پر.?دانلود/u.test(clean(text))
        );
        if (popularityButton) {
          ordered = await sendAndCollect(client, popularityButton, {
            timeoutMs: config.searchTimeoutMs,
            quietMs: 1800,
            stopWhen: message => replyButtons(message)
              .some(text => parseTrackButton(text, selectedArtist)),
          });
        }
      }

      topTracks = parseTracksFromMessages(ordered.messages, selectedArtist);
      bulkHighButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
      );
    } catch (err) {
      console.warn('[melobot artist sort]', err.message);
    }
  }

  if (!topTracks.length) topTracks = recentTracks;

  return {
    artist: selectedArtist,
    tracks: topTracks,
    topTracks,
    recentTracks,
    albumButton,
    orderButton,
    bulkHighButton,
    relatedArtists,
  };
}

export async function prepareMeloBotBulkTopTracks(client, artist, preferredSeed = null) {
  const context = await openMeloBotArtistFresh(client, artist, preferredSeed);
  if (!context.bulkHighButton) {
    throw new Error('MeloBot bulk HQ button was not found after rebuilding the sorted artist page.');
  }
  return context;
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

export async function downloadMeloBotTopTracks(client, artistContext) {
  const button = artistContext.bulkHighButton;
  if (!button) throw new Error('MeloBot bulk HQ button not found on the sorted artist page.');

  const download = await sendAndCollect(client, button, {
    timeoutMs: Math.max(config.downloadTimeoutMs, 120000),
    quietMs: 8500,
  });

  const audios = download.messages.filter(isAudioMessage).map(audioMeta);
  if (!audios.length) {
    const response = download.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`MeloBot bulk HQ did not deliver audio. ${response.slice(0, 350)}`);
  }

  return {
    source: 'melobot',
    audioItems: audios,
  };
}

export function matchBulkAudioToTracks(tracks, audioItems) {
  const unused = audioItems.map((item, index) => ({ ...item, index }));
  const matches = [];

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

    if (!best || bestScore <= 0) best = unused.find(item => !item.used) || null;
    if (!best) break;
    best.used = true;
    matches.push({ track, audioItem: best });
  }

  return matches;
}

export async function listMeloBotAlbums(client, artistContext) {
  const albumControl = clean(artistContext.albumButton || '');
  if (!albumControl) throw new Error('MeloBot album button is not present on the live artist keyboard.');

  const page = await sendAndCollect(client, albumControl, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 2000,
    stopWhen: m => replyButtons(m).some(text => parseAlbumButton(text)),
  });

  const albums = [];
  const seen = new Set();
  for (const rawText of buttonsFromMessages(page.messages)) {
    const album = parseAlbumButton(rawText);
    if (!album) continue;
    const key = album.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push(album);
  }

  if (!albums.length) {
    const response = page.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`No albums found in MeloBot artist page. ${response.slice(0, 350)}`);
  }

  console.log(`[melobot] albums for ${artistContext.artist}: ${albums.length}`);
  return albums;
}

export async function openMeloBotAlbum(client, artist, album) {
  const page = await sendAndCollect(client, album.rawText, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 2000,
    stopWhen: m => replyButtons(m).some(text => parseTrackButton(text, artist)),
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

  if (!tracks.length) {
    const response = page.messages.map(messageText).filter(Boolean).join('\n');
    throw new Error(`No tracks found in MeloBot album ${album.title}. ${response.slice(0, 350)}`);
  }

  console.log(`[melobot] album ${album.title}: ${tracks.length} tracks`);
  return tracks;
}

export async function discoverMeloBotHome(client, { maxSections = 3 } = {}) {
  // Bootstrap only through buttons that actually exist on MeloBot's live keyboard.
  // Never invent a button label such as "💿".
  const openHome = async () => {
    let page = await sendAndCollect(client, '/start', {
      timeoutMs: config.searchTimeoutMs,
      quietMs: 1800,
    });

    const homeButton = findButton(page.messages, text => /صفحه\s*اصلی/u.test(clean(text)));
    if (homeButton) {
      try {
        page = await sendAndCollect(client, homeButton, {
          timeoutMs: config.searchTimeoutMs,
          quietMs: 1800,
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
        quietMs: 2200,
        stopWhen: message => replyButtons(message).some(text => Boolean(parseTrackButton(text))),
      });
      absorb(section.messages);
    } catch (err) {
      console.warn('[melobot bootstrap section]', sectionButton, err.message);
    }
  }

  return { tracks, artists, sections: sectionButtons };
}
