import { config } from './config.js';

export const SESSION_TTL_MS = 12 * 60 * 1000;
export const MAX_RESULTS = 5;
export const ALBUMS_PER_PAGE = 7;
export const TOP_TRACKS_LIMIT = 10;

export function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function normalize(value = '') {
  return clean(value).toLocaleLowerCase('en-US');
}

export function numberEmoji(index) {
  return ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][index] || `${index + 1}.`;
}

export function truncate(text, max = 47) {
  const value = clean(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function trackButtonLabel(track, index, { numbered = false } = {}) {
  const prefix = `${numbered ? `${numberEmoji(index)} ` : ''}🎵 `;
  const body = track.artist ? `${track.artist} — ${track.title}` : track.title;
  return truncate(`${prefix}${body}`);
}

function dominantArtist(tracks) {
  const counts = new Map();
  for (const track of tracks || []) {
    if (!track.artist) continue;
    const key = normalize(track.artist);
    const current = counts.get(key) || { artist: track.artist, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const best = [...counts.values()].sort((a,b) => b.count - a.count)[0];
  if (!best || best.count < Math.min(2, tracks.length)) return null;
  return best.artist;
}

export function resultsKeyboard(sessionId, session) {
  const artist = dominantArtist(session.options || []);
  const rows = (session.options || []).map((track,index) => ([{
    text: trackButtonLabel(track,index,{ numbered: true }),
    callback_data: `t:${sessionId}:${index}`,
  }]));
  const hasMeloArtist = artist && session.options.some(t =>
    t.source === 'melobot' && (!t.artist || normalize(t.artist) === normalize(artist))
  );
  if (hasMeloArtist) rows.push([{ text: `صفحه‌ی 🗣 ${truncate(artist,30)}`, callback_data: `ar:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function artistHomeKeyboard(sessionId, artistContext, isFollowing = false) {
  const rows = [];
  if (artistContext.tracks?.length) {
    rows.push([
      { text: '🎵 پربازدیدترین‌ها', callback_data: `ars:${sessionId}` },
      { text: '💿 آلبوم‌ها', callback_data: `alb:${sessionId}:0` },
    ]);
  } else {
    rows.push([{ text: '💿 آلبوم‌ها', callback_data: `alb:${sessionId}:0` }]);
  }
  rows.push([
    { text: isFollowing ? '🔕 آنفالو' : '🔔 فالو', callback_data: `fol:${sessionId}` },
    { text: '‹ برگشت', callback_data: `rs:${sessionId}` },
  ]);
  return { inline_keyboard: rows };
}

export function artistSongsKeyboard(sessionId, tracks) {
  const visible = (tracks || []).slice(0, TOP_TRACKS_LIMIT);
  const rows = visible.map((track,index) => ([{
    text: trackButtonLabel(track,index,{ numbered: true }),
    callback_data: `at:${sessionId}:${index}`,
  }]));
  if (visible.length) rows.push([{ text: '📥 دانلود همه با کیفیت عالی', callback_data: `ata:${sessionId}` }]);
  rows.push([{ text: '‹ خواننده', callback_data: `arh:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function albumsKeyboard(sessionId, albums, page) {
  const start = page * ALBUMS_PER_PAGE;
  const visible = (albums || []).slice(start,start + ALBUMS_PER_PAGE);
  const rows = visible.map((album,offset) => ([{
    text: truncate(`💿 ${album.title}${album.trackCount ? ` · ${album.trackCount} آهنگ` : ''}`),
    callback_data: `ao:${sessionId}:${start + offset}`,
  }]));
  const nav = [];
  if (page > 0) nav.push({ text: '‹', callback_data: `alb:${sessionId}:${page - 1}` });
  if (start + ALBUMS_PER_PAGE < albums.length) nav.push({ text: '›', callback_data: `alb:${sessionId}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '‹ خواننده', callback_data: `arh:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function albumTracksKeyboard(sessionId, tracks, backPage = 0) {
  const rows = (tracks || []).slice(0,12).map((track,index) => ([{
    text: trackButtonLabel(track,index),
    callback_data: `alt:${sessionId}:${index}`,
  }]));
  rows.push([{ text: '‹ آلبوم‌ها', callback_data: `alb:${sessionId}:${backPage}` }]);
  return { inline_keyboard: rows };
}

export function minimalBrandCaption() {
  return clean(config.brandCaption).replace(/^🎧\s*/u,'') || `@${config.botUsername}`;
}
