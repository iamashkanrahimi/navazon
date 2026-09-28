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

export async function openMeloBotArtist(client, seedTrack) {
  const menuMessages = await openTrackMenu(client, seedTrack);
  const artistButton = findButton(menuMessages, text =>
    text.includes('خواننده') && !text.includes('پیشنهاد')
  );
  if (!artistButton) throw new Error('MeloBot artist button not found.');

  const artistPage = await sendAndCollect(client, artistButton, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1800,
    stopWhen: m => {
      const buttons = replyButtons(m);
      return buttons.some(text => parseTrackButton(text, seedTrack.artist)) ||
        buttons.some(text => /^💿(?:\s|$)/u.test(clean(text)));
    },
  });

  const allButtons = buttonsFromMessages(artistPage.messages);
  const recentTracks = parseTracksFromMessages(artistPage.messages, seedTrack.artist);

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
        stopWhen: m => {
          const buttons = replyButtons(m);
          const hasTracks = buttons.some(text => parseTrackButton(text, seedTrack.artist));
          const hasBulkHq = buttons.some(text =>
            /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
          );
          return hasTracks && hasBulkHq;
        },
      });

      if (!parseTracksFromMessages(ordered.messages, seedTrack.artist).length) {
        const popularityButton = findButton(ordered.messages, text =>
          /بازدید|محبوب|برتر|پر.?دانلود/u.test(clean(text))
        );
        if (popularityButton) {
          ordered = await sendAndCollect(client, popularityButton, {
            timeoutMs: config.searchTimeoutMs,
            quietMs: 1800,
            stopWhen: m => replyButtons(m).some(text => parseTrackButton(text, seedTrack.artist)),
          });
        }
      }

      topTracks = parseTracksFromMessages(ordered.messages, seedTrack.artist);
      bulkHighButton = findButton(ordered.messages, text =>
        /دانلود همه/u.test(clean(text)) && /عالی/u.test(clean(text))
      );
    } catch (err) {
      console.warn('[melobot artist sort]', err.message);
    }
  }

  if (!topTracks.length) topTracks = recentTracks;

  return {
    artist: seedTrack.artist,
    tracks: topTracks,
    topTracks,
    recentTracks,
    albumButton,
    orderButton,
    bulkHighButton,
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
  const albumControl = artistContext.albumButton || '💿';

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

export async function discoverMeloBotHome(client) {
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

  const tracks = parseTracksFromMessages(page.messages);
  const artists = [];
  const seen = new Set();
  for (const raw of buttonsFromMessages(page.messages)) {
    const text = clean(raw);
    const match = text.match(/^[🗣🎤🎙]+\s*(.+)$/u);
    if (!match) continue;
    const name = clean(match[1]);
    const key = normalize(name);
    if (!key || seen.has(key) || /خواننده|پیشنهاد/u.test(name)) continue;
    seen.add(key);
    artists.push(name);
  }

  return { tracks, artists };
}
