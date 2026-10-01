import { CURATED_PLAYLISTS } from './homeCatalog.js';
import { cleanText, normalizeText, meaningfulSearchTokens, hasAlbumIntent } from './text.js';

export const SESSION_TTL_MS = 12 * 60 * 1000;
export const BUSY_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_RESULTS = 5;
export const ALBUMS_PER_PAGE = 7;
export const ALBUM_TRACKS_PER_PAGE = 10;
export const TOP_TRACKS_LIMIT = 10;

export function clean(value = '') {
  return cleanText(value);
}

export function normalize(value = '') {
  return normalizeText(value);
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
  const body = track.artist && !track.artistInferred
    ? `${track.artist} — ${track.title}`
    : track.title;
  return truncate(`${prefix}${body}`);
}

export function albumButtonLabel(album) {
  const body = album.artist ? `${album.artist} — ${album.title}` : album.title;
  return truncate(`💿${body}`);
}

export function artistAlbumsTitle(artist = '', count = null) {
  const suffix = Number.isFinite(Number(count)) && Number(count) > 0
    ? ` · ${Number(count)}`
    : '';
  return `💿 آلبوم‌های ${clean(artist) || 'خواننده'}${suffix}`;
}

export function albumPageTitle(album = {}, fallbackArtist = '') {
  const title = clean(album?.title || 'آلبوم');
  const artist = clean(album?.artist || fallbackArtist);
  const count = Number(album?.trackCount || album?.tracks?.length || 0);
  const countText = count > 0 ? ` (${count} آهنگ)` : '';
  return [`💿 ${title}${countText}`, artist].filter(Boolean).join('\n');
}

function artistShortcutMatchesQuery(query = '', artist = '') {
  if (!clean(query)) return true;
  const queryTokens = meaningfulSearchTokens(query);
  const artistTokens = new Set(normalize(artist).split(' ').filter(Boolean));
  if (!queryTokens.length || !artistTokens.size) return false;
  return queryTokens.every(token => artistTokens.has(token));
}

function dominantArtist(tracks) {
  const counts = new Map();
  for (const track of tracks || []) {
    if (!track.artist || track.source !== 'melobot') continue;
    const key = normalize(track.artist);
    const current = counts.get(key) || { artist: track.artist, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const best = [...counts.values()].sort((a,b) => b.count - a.count)[0];

  // A single search row is not strong enough evidence for a direct Artist-page
  // shortcut: ambiguous album-like hits have historically surfaced as one
  // pseudo-track. Require at least two independent MeloBot track rows.
  if (!best || best.count < 2) return null;
  return best.artist;
}

export function homeKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '🔥 تازه‌ها', callback_data: `hnew:${sessionId}` },
        { text: '🏆 پردانلودها', callback_data: `htop:${sessionId}` },
      ],
      [
        { text: '🎧 پلی‌لیست‌ها', callback_data: `hpl:${sessionId}` },
        { text: '♡ دنبال‌شده‌ها', callback_data: `hfol:${sessionId}` },
      ],
    ],
  };
}

export function newestMenuKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '🇮🇷 ایرانی', callback_data: `hnc:${sessionId}:ir` },
        { text: '🌍 خارجی', callback_data: `hnc:${sessionId}:foreign` },
      ],
      [
        { text: '🇹🇷 ترکی', callback_data: `hnc:${sessionId}:tr` },
        { text: '🎶 عربی', callback_data: `hnc:${sessionId}:ar` },
      ],
      [{ text: '↩️ خانه', callback_data: `hmn:${sessionId}` }],
    ],
  };
}

export function topMenuKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: '☀️ امروز', callback_data: `htc:${sessionId}:day` },
        { text: '📅 این هفته', callback_data: `htc:${sessionId}:week` },
      ],
      [{ text: '↩️ خانه', callback_data: `hmn:${sessionId}` }],
    ],
  };
}

export function curatedPlaylistsKeyboard(sessionId, playlists = CURATED_PLAYLISTS) {
  const rows = (playlists || []).slice(0, 6).map((playlist, index) => ([{
    text: truncate(playlist.uiLabel || `🎧 ${playlist.label || playlist.title || playlist.rawText || 'پلی‌لیست'}`, 38),
    callback_data: `hpo:${sessionId}:${index}`,
  }]));
  rows.push([{ text: '↩️ خانه', callback_data: `hmn:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function followedArtistsKeyboard(sessionId, artists = []) {
  const rows = (artists || []).slice(0, 12).map((artist, index) => ([{
    text: `🎤 ${truncate(artist.artist_name || artist.artistName || artist.artist || '', 38)}`,
    callback_data: `hfa:${sessionId}:${index}`,
  }]));
  rows.push([{ text: '↩️ خانه', callback_data: `hmn:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function resultsKeyboard(sessionId, session) {
  const tracks = session.options || [];
  const queryKey = normalize(session.query || '');
  const exactArtistSeedIndex = !hasAlbumIntent(session.query)
    ? tracks.findIndex(track =>
        track?.source === 'melobot'
        && !track?.artistInferred
        && normalize(track.artist || '') === queryKey
      )
    : -1;

  const dominant = dominantArtist(tracks);
  const matchingArtists = new Set(
    tracks
      .filter(track =>
        track?.source === 'melobot'
        && !track?.artistInferred
        && artistShortcutMatchesQuery(session.query, track.artist || '')
      )
      .map(track => normalize(track.artist || ''))
      .filter(Boolean)
  );

  const artist = exactArtistSeedIndex >= 0
    ? tracks[exactArtistSeedIndex].artist
    : (
        !queryKey
          ? dominant
          : (
              dominant
              && matchingArtists.size === 1
              && artistShortcutMatchesQuery(session.query, dominant)
                ? dominant
                : null
            )
      );

  const trackRows = tracks.map((track,index) => ([{
    text: trackButtonLabel(track,index,{ numbered: session.resultsNumbered === true }),
    callback_data: `t:${sessionId}:${index}`,
  }]));

  const albumRows = (session.albumOptions || []).map((album,index) => ([{
    text: albumButtonLabel(album),
    callback_data: `sal:${sessionId}:${index}`,
  }]));

  const rows = session.albumFirst
    ? [...albumRows, ...trackRows]
    : [...trackRows, ...albumRows];

  const artistSeedIndex = artist
    ? (
        exactArtistSeedIndex >= 0
          ? exactArtistSeedIndex
          : tracks.findIndex(t =>
              t.source === 'melobot'
              && !t.artistInferred
              && normalize(t.artist || '') === normalize(artist)
            )
      )
    : -1;
  if (artistSeedIndex >= 0) {
    rows.push([{
      text: `🎤 ${truncate(artist,30)}`,
      callback_data: `ar:${sessionId}:${artistSeedIndex}`,
    }]);
  } else {
    const albumArtists = new Map();
    (session.albumOptions || []).forEach((album, index) => {
      if (!album?.artist) return;
      const key = normalize(album.artist);
      if (!key) return;
      if (!albumArtists.has(key)) {
        albumArtists.set(key, { artist: album.artist, index });
      }
    });

    if (albumArtists.size === 1) {
      const only = [...albumArtists.values()][0];
      if (
        !hasAlbumIntent(session.query)
        && !artistShortcutMatchesQuery(session.query, only.artist)
      ) {
        if (session.resultsBackAction) {
          rows.push([{
            text: session.resultsBackText || '↩️ برگشت',
            callback_data: `${session.resultsBackAction}:${sessionId}`,
          }]);
        }
        return { inline_keyboard: rows };
      }
      rows.push([{
        text: `🎤 ${truncate(only.artist,30)}`,
        callback_data: `aar:${sessionId}:${only.index}`,
      }]);
    }
  }
  if (session.resultsBackAction) {
    rows.push([{
      text: session.resultsBackText || '↩️ برگشت',
      callback_data: `${session.resultsBackAction}:${sessionId}`,
    }]);
  }
  return { inline_keyboard: rows };
}

export function artistHomeKeyboard(sessionId, artistContext, isFollowing = false, { backAction = 'rs' } = {}) {
  const rows = [[
    { text: '🔥 پربازدیدها', callback_data: `ars:${sessionId}` },
    { text: '🆕 تازه‌ها', callback_data: `arn:${sessionId}` },
  ]];

  const secondRow = [
    { text: '💿 آلبوم‌ها', callback_data: `alb:${sessionId}:0` },
    { text: isFollowing ? '♥ دنبال می‌کنی' : '♡ دنبال کردن', callback_data: `fol:${sessionId}` },
  ];
  rows.push(secondRow);

  rows.push([{ text: '↩️ برگشت', callback_data: `${backAction}:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function artistSongsKeyboard(sessionId, tracks, { mode = 'top' } = {}) {
  const visible = (tracks || []).slice(0, TOP_TRACKS_LIMIT);
  const trackAction = mode === 'recent' ? 'rt' : 'at';
  const bulkAction = mode === 'recent' ? 'rta' : 'ata';
  const bulkText = '⬇️ دانلود همه';

  const rows = visible.map((track,index) => {
    const prefix = mode === 'top' ? `${numberEmoji(index)} ` : '';
    return [{
      text: truncate(`${prefix}🎵 ${clean(track?.title || 'آهنگ')}`),
      callback_data: `${trackAction}:${sessionId}:${index}`,
    }];
  });
  if (visible.length) rows.push([{ text: bulkText, callback_data: `${bulkAction}:${sessionId}` }]);
  rows.push([{ text: '↩️ خواننده', callback_data: `arh:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function trackPageTitle(track = {}) {
  const artist = clean(track.artist || '');
  const title = clean(track.title || '');
  return [track.artistInferred ? '' : artist, title].filter(Boolean).join(' — ') || 'آهنگ';
}

export function trackPageKeyboard(sessionId, track, details = {}, capabilities = {}) {
  const rows = [];
  const media = details?.media || {};
  const isMeloBot = track?.source === 'melobot';

  // MeloBot capability discovery is intentionally lazy. A temporary source
  // timeout must never make an action disappear from the page.
  const qualityRow = [];
  if (
    media.hq
    || capabilities.hasHq === true
    || (isMeloBot && capabilities.hasHq !== false)
  ) {
    qualityRow.push({
      // Keep quality selection out of the product UI. Navazon serves the best
      // available primary download path behind one clear action.
      text: '⬇️ دانلود آهنگ',
      callback_data: `tqh:${sessionId}`,
    });
  }
  // Normal-quality files/capabilities remain stored for backward
  // compatibility, but the action is intentionally hidden from all newly
  // rendered Track pages. Old Telegram messages may still carry a legacy
  // tqn:* callback and are handled by the callback router without exposing a
  // new button.
  if (qualityRow.length) rows.push(qualityRow);

  const extras = [];
  const hasKnownLyrics = Boolean(details?.lyrics_text);
  const lyricsKnownMissing = details?.metadata?.hasLyrics === false || capabilities.hasLyrics === false;
  if (
    hasKnownLyrics
    || (!lyricsKnownMissing && capabilities.hasLyrics === true)
    || (isMeloBot && !lyricsKnownMissing && capabilities.hasLyrics !== false)
  ) {
    extras.push({ text: '📝 متن', callback_data: `tly:${sessionId}` });
  }
  if (
    details?.cover_file_id
    || capabilities.hasCover === true
    || (isMeloBot && capabilities.hasCover !== false)
  ) {
    extras.push({ text: '🖼 کاور', callback_data: `tcv:${sessionId}` });
  }
  if (extras.length) rows.push(extras);

  const infoRow = [];
  const hasInfo = Boolean(
    details?.release_date || details?.release_date_raw || details?.duration_seconds ||
    details?.popularity_count || details?.popularity_text || details?.albumInfo ||
    capabilities.hasMetadata
  );
  if (
    hasInfo
    || capabilities.hasMetadata === true
    || (isMeloBot && capabilities.hasMetadata !== false)
  ) {
    infoRow.push({ text: 'ℹ️ اطلاعات', callback_data: `tif:${sessionId}` });
  }
  if (
    track?.artist
    && !track?.artistInferred
    && capabilities.hasArtistPage === true
  ) {
    infoRow.push({ text: '🎤 خواننده', callback_data: `tar:${sessionId}` });
  }
  if (infoRow.length) rows.push(infoRow);

  if (details?.albumInfo?.album_key) {
    rows.push([{
      text: truncate(`💿 ${details.albumInfo.title}`, 47),
      callback_data: `tal:${sessionId}`,
    }]);
  }

  rows.push([{ text: '↩️ برگشت', callback_data: `tbk:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function albumsErrorKeyboard(sessionId, page = 0) {
  return {
    inline_keyboard: [
      [{ text: '🔄 دوباره امتحان کن', callback_data: `alb:${sessionId}:${Math.max(0, Number(page || 0))}` }],
      [{ text: '↩️ خواننده', callback_data: `arh:${sessionId}` }],
    ],
  };
}

export function noAlbumsKeyboard(sessionId) {
  return {
    inline_keyboard: [[
      { text: '↩️ خواننده', callback_data: `arh:${sessionId}` },
    ]],
  };
}

export function albumsKeyboard(sessionId, albums, page, fallbackArtist = '') {
  const start = page * ALBUMS_PER_PAGE;
  const visible = (albums || []).slice(start,start + ALBUMS_PER_PAGE);
  const rows = visible.map((album,offset) => {
    const artist = clean(album?.artist || fallbackArtist);
    const label = artist
      ? `💿${artist} — ${clean(album?.title || 'آلبوم')}`
      : `💿${clean(album?.title || 'آلبوم')}`;
    return [{
      text: truncate(label),
      callback_data: `ao:${sessionId}:${start + offset}`,
    }];
  });
  const nav = [];
  if (page > 0) nav.push({ text: '‹ قبلی', callback_data: `alb:${sessionId}:${page - 1}` });
  if (start + ALBUMS_PER_PAGE < albums.length) nav.push({ text: 'بعدی ›', callback_data: `alb:${sessionId}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '↩️ خواننده', callback_data: `arh:${sessionId}` }]);
  return { inline_keyboard: rows };
}

function pagedAlbumTrackRows(sessionId, tracks, page = 0) {
  const list = tracks || [];
  const safePage = Math.max(0, Number(page || 0));
  const start = safePage * ALBUM_TRACKS_PER_PAGE;
  const visible = list.slice(start, start + ALBUM_TRACKS_PER_PAGE);
  const rows = visible.map((track, offset) => ([{
    text: truncate(`🎵 ${clean(track?.title || 'آهنگ')}`),
    callback_data: `alt:${sessionId}:${start + offset}`,
  }]));

  const nav = [];
  if (safePage > 0) nav.push({ text: '‹ قبلی', callback_data: `apg:${sessionId}:${safePage - 1}` });
  if (start + ALBUM_TRACKS_PER_PAGE < list.length) {
    nav.push({ text: 'بعدی ›', callback_data: `apg:${sessionId}:${safePage + 1}` });
  }
  if (nav.length) rows.push(nav);
  return rows;
}

export function trackAlbumKeyboard(sessionId, album, tracks, page = 0) {
  const rows = pagedAlbumTrackRows(sessionId, tracks, page);
  if ((tracks || []).length) {
    rows.push([{ text: '⬇️ دانلود همه‌ی آلبوم', callback_data: `ala:${sessionId}` }]);
  }
  rows.push([{ text: '🎤 صفحه‌ی خواننده', callback_data: `tar:${sessionId}` }]);
  rows.push([{ text: '↩️ آهنگ', callback_data: `tret:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function albumTracksKeyboard(
  sessionId,
  tracks,
  backPage = 0,
  page = 0,
  { backAction = 'albums', artistCallbackData = null } = {}
) {
  const rows = pagedAlbumTrackRows(sessionId, tracks, page);
  if ((tracks || []).length) {
    rows.push([{ text: '⬇️ دانلود همه‌ی آلبوم', callback_data: `ala:${sessionId}` }]);
  }

  rows.push([{
    text: '🎤 صفحه‌ی خواننده',
    callback_data: artistCallbackData || `arh:${sessionId}`,
  }]);

  if (backAction === 'results') {
    rows.push([{ text: '↩️ نتایج', callback_data: `rs:${sessionId}` }]);
  } else if (backAction === 'fallback') {
    rows.push([{ text: '↩️ برگشت', callback_data: `rs:${sessionId}` }]);
  } else {
    rows.push([{ text: '↩️ آلبوم‌ها', callback_data: `alb:${sessionId}:${backPage}` }]);
  }
  return { inline_keyboard: rows };
}

export function bulkDownloadSummary(sent = 0, missing = 0) {
  const ready = Math.max(0, Number(sent || 0));
  const missed = Math.max(0, Number(missing || 0));

  if (!missed && ready > 0) {
    return `همه‌ی ${ready} آهنگ آماده شد.`;
  }
  if (ready > 0) {
    return `${ready} آهنگ آماده شد.\n${missed} تای دیگه فعلاً نرسید؛ به نظرم دوباره امتحان کن.`;
  }
  return 'دانلود یکجا موفقیت‌آمیز نبود.\nاگه میخوای دوباره امتحان کن یا آهنگ‌ها رو تکی بگیر.';
}

export function minimalBrandCaption() {
  return '🎧 @NavazonBot';
}
