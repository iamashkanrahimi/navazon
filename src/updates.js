import { randomBytes } from 'node:crypto';
import { bot, bridge, follows, sessions } from './runtime.js';
import { sourceQueue, showResults } from './jobs.js';
import {
  SESSION_TTL_MS, BUSY_SESSION_TTL_MS, TOP_TRACKS_LIMIT,
  homeKeyboard, newestMenuKeyboard, topMenuKeyboard,
  curatedPlaylistsKeyboard, followedArtistsKeyboard,
  artistHomeKeyboard, artistSongsKeyboard, albumsKeyboard,
  albumTracksKeyboard, trackAlbumKeyboard,
} from './ui.js';
import { noteUserActivity } from './state.js';
import { CURATED_PLAYLISTS } from './homeCatalog.js';
import { renderTrackPage } from './trackActions.js';

const lastSearchAt = new Map();
const SEARCH_COOLDOWN_MS = 1000;
const MAX_SOURCE_QUEUE = 30;

function searchAllowed(userId) {
  const now = Date.now();
  const key = String(userId);
  const last = lastSearchAt.get(key) || 0;
  if (now - last < SEARCH_COOLDOWN_MS) return false;
  lastSearchAt.set(key, now);

  if (lastSearchAt.size > 1000) {
    for (const [id, at] of lastSearchAt) {
      if (now - at > 10 * 60 * 1000) lastSearchAt.delete(id);
    }
  }
  return true;
}

async function openTrackPageLocal(sessionId, session, messageId) {
  try {
    await renderTrackPage(sessionId, session, messageId);
  } catch (err) {
    console.error('[track page local]', err.message);
    await bot.editMessageText(
      session.chatId,
      messageId,
      'باز کردن صفحه‌ی آهنگ ممکن نشد.'
    );
  } finally {
    session.busy = false;
  }
}

function newSessionId() {
  return randomBytes(4).toString('hex');
}

async function sendHome(chatId, userId) {
  const sessionId = newSessionId();
  const session = {
    chatId,
    userId,
    messageId: null,
    options: [],
    albumOptions: [],
    artistContext: null,
    artistSeed: null,
    followedArtists: [],
    isFollowing: false,
    albums: null,
    albumsEmptyConfirmed: false,
    currentAlbum: null,
    currentAlbumView: null,
    albumsPage: 0,
    albumTrackPage: 0,
    currentTrack: null,
    trackBack: null,
    artistBack: 'hmn',
    busy: false,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const message = await bot.sendMessage(
    chatId,
    'اسم آهنگ، خواننده یا آلبوم رو بفرست 🎵\n\nیا از بخش‌های زیر انتخاب کن:',
    { reply_markup: homeKeyboard(sessionId) }
  );
  session.messageId = message.message_id;
  await sessions.set(sessionId, session);
}

function validSession(callback, session) {
  return session && session.expiresAt > Date.now() && callback.from?.id === session.userId;
}

export async function handleUpdate(update) {
  // Crawler/user-account bridge messages can arrive in bursts. Consume them
  // before touching the sessions table so batch media warming stays fast.
  const bridgeMessage = update.message;
  if (bridgeMessage && bridge.consumeBotMessage(bridgeMessage)) return;

  await sessions.cleanup();
  const callback = update.callback_query;
  if (callback) {
    const parts = (callback.data || '').split(':');
    const action = parts[0];
    const sessionId = parts[1];
    const session = await sessions.get(sessionId);
    if (!validSession(callback,session)) {
      await bot.answerCallbackQuery(callback.id,{ text: 'این جست‌وجو منقضی شده. دوباره جست‌وجو کن.' });
      return;
    }
    try {
      if (session.busy) {
        await bot.answerCallbackQuery(callback.id,{ text: 'یک لحظه…' });
        return;
      }
      const messageId = callback.message?.message_id || session.messageId;
      await bot.answerCallbackQuery(callback.id);
      await noteUserActivity();

      if (action === 'hmn') {
        session.busy = false;
        session.resultsBackAction = null;
        session.resultsBackText = null;
        await bot.editMessageText(
          session.chatId,
          messageId,
          'اسم آهنگ، خواننده یا آلبوم رو بفرست 🎵\n\nیا از بخش‌های زیر انتخاب کن:',
          { reply_markup: homeKeyboard(sessionId) }
        );
      } else if (action === 'hnew') {
        await bot.editMessageText(
          session.chatId,
          messageId,
          '🔥 جدیدترین‌ها\nدسته‌بندی رو انتخاب کن:',
          { reply_markup: newestMenuKeyboard(sessionId) }
        );
      } else if (action === 'htop') {
        await bot.editMessageText(
          session.chatId,
          messageId,
          '📥 پردانلودترین‌ها\nبازه رو انتخاب کن:',
          { reply_markup: topMenuKeyboard(sessionId) }
        );
      } else if (action === 'hnc' || action === 'htc') {
        session.busy = true;
        const feedKey = parts[2];
        await bot.editMessageText(session.chatId, messageId, 'در حال دریافت آهنگ‌ها…');
        sourceQueue.push({ type: 'home_feed', sessionId, messageId, feedKey });
      } else if (action === 'hpl') {
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          messageId,
          '🎧 پلی‌لیست‌ها\nچند پلی‌لیست منتخب:',
          { reply_markup: curatedPlaylistsKeyboard(sessionId) }
        );
      } else if (action === 'hpo') {
        session.busy = true;
        const playlistIndex = Number(parts[2]);
        const playlist = CURATED_PLAYLISTS[playlistIndex];
        if (!playlist) {
          session.busy = false;
          return;
        }
        await bot.editMessageText(session.chatId, messageId, 'در حال باز کردن پلی‌لیست…');
        sourceQueue.push({
          type: 'home_playlist',
          sessionId,
          messageId,
          playlistKey: playlist.key,
        });
      } else if (action === 'hfol') {
        session.followedArtists = await follows.listForUser(session.userId, 12);
        if (!session.followedArtists.length) {
          await bot.editMessageText(
            session.chatId,
            messageId,
            '🔔 دنبال‌شده‌ها\n\nهنوز خواننده‌ای رو فالو نکردی.',
            { reply_markup: followedArtistsKeyboard(sessionId, []) }
          );
        } else {
          await bot.editMessageText(
            session.chatId,
            messageId,
            '🔔 خواننده‌های دنبال‌شده',
            { reply_markup: followedArtistsKeyboard(sessionId, session.followedArtists) }
          );
        }
      } else if (action === 'hfa') {
        const index = Number(parts[2]);
        if (!session.followedArtists?.[index]) return;
        session.busy = true;
        await bot.editMessageText(session.chatId, messageId, 'در حال باز کردن خواننده…');
        sourceQueue.push({ type: 'home_artist', sessionId, messageId, index });
      } else if (action === 't') {
        const track = session.options[Number(parts[2])]; if (!track) return;
        session.currentTrack = track;
        session.trackBack = { type: 'results' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'sal') {
        const album = session.albumOptions?.[Number(parts[2])]; if (!album) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آلبوم…');
        sourceQueue.push({
          type: 'search_album',
          sessionId,
          messageId,
          index: Number(parts[2]),
        });
      } else if (action === 'ar') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن خواننده…');
        sourceQueue.push({
          type: 'artist',
          sessionId,
          messageId,
          seedIndex: Number(parts[2]),
        });
      } else if (action === 'aar') {
        const albumIndex = Number(parts[2]);
        const album = session.albumOptions?.[albumIndex];
        if (!album?.artist) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن خواننده…');
        sourceQueue.push({
          type: 'artist_from_album',
          sessionId,
          messageId,
          albumIndex,
        });
      } else if (action === 'rs') {
        await showResults(sessionId,session,messageId);
      } else if (action === 'trt') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال بازگشت به آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tret') {
        if (session.albumOriginTrack) {
          session.currentTrack = session.albumOriginTrack;
          session.trackBack = session.albumOriginBack || { type: 'results' };
        }
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال بازگشت به آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tbk') {
        const back = session.trackBack || { type: 'results' };
        if (back.type === 'top' && session.artistContext) {
          const tracks = session.artistContext.topTracks || [];
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n🎵 پربازدیدترین آثار`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'top' }),
          });
        } else if (back.type === 'recent' && session.artistContext) {
          const tracks = session.artistContext.recentTracks || [];
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n🆕 جدیدترین آثار`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'recent' }),
          });
        } else if (back.type === 'album' && session.currentAlbum) {
          const title = `💿 ${session.currentAlbum.title}\n${session.currentAlbum.artist || session.artistContext?.artist || ''}`;
          const keyboard = session.currentAlbumView === 'track'
            ? trackAlbumKeyboard(
                sessionId,
                session.currentAlbum,
                session.currentAlbum.tracks,
                session.albumTrackPage || 0
              )
            : albumTracksKeyboard(
                sessionId,
                session.currentAlbum.tracks,
                session.albumsPage || 0,
                session.albumTrackPage || 0,
                { backAction: session.currentAlbumView === 'search' ? 'results' : 'albums' }
              );
          await bot.editMessageText(session.chatId,messageId,title,{ reply_markup: keyboard });
        } else {
          await showResults(sessionId,session,messageId);
        }
      } else if (action === 'arh' && session.artistContext) {
        await bot.editMessageText(session.chatId,messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(
            sessionId,
            session.artistContext,
            session.isFollowing,
            { backAction: session.artistBack || 'rs' }
          ),
        });
      } else if (action === 'fol' && session.artistContext) {
        session.isFollowing = await follows.toggle(session.userId,session.artistContext.artist);
        await bot.editMessageText(session.chatId,messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(
            sessionId,
            session.artistContext,
            session.isFollowing,
            { backAction: session.artistBack || 'rs' }
          ),
        });
      } else if (action === 'ars' && session.artistContext) {
        const tracks = session.artistContext.topTracks || [];
        if (tracks.length) {
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n🎵 پربازدیدترین آثار`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'top' }),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'در حال دریافت پربازدیدترین آثار…');
          sourceQueue.push({ type: 'artist_list', mode: 'top', sessionId, messageId });
        }
      } else if (action === 'arn' && session.artistContext) {
        const tracks = session.artistContext.recentTracks || [];
        if (tracks.length) {
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n🆕 جدیدترین آثار`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'recent' }),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'در حال دریافت جدیدترین آثار…');
          sourceQueue.push({ type: 'artist_list', mode: 'recent', sessionId, messageId });
        }
      } else if (action === 'ata' && session.artistContext?.tracks?.length) {
        session.busy = true;
        const tracks = session.artistContext.topTracks || session.artistContext.tracks || [];
        const count = Math.min(TOP_TRACKS_LIMIT,tracks.length);
        await bot.editMessageText(session.chatId,messageId,`در حال دریافت ${count} آهنگ برتر…`);
        sourceQueue.push({ type: 'download_top', sessionId, messageId });
      } else if (action === 'rta' && session.artistContext?.recentTracks?.length) {
        session.busy = true;
        const count = Math.min(TOP_TRACKS_LIMIT,session.artistContext.recentTracks.length);
        await bot.editMessageText(session.chatId,messageId,`در حال دریافت ${count} آهنگ جدید…`);
        sourceQueue.push({ type: 'download_recent', sessionId, messageId });
      } else if (action === 'at') {
        const tracks = session.artistContext?.topTracks || [];
        const track = tracks[Number(parts[2])]; if (!track) return;
        session.currentTrack = { ...track, source: track.source || 'melobot' };
        session.trackBack = { type: 'top' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'rt') {
        const track = session.artistContext?.recentTracks?.[Number(parts[2])]; if (!track) return;
        session.currentTrack = { ...track, source: track.source || 'melobot' };
        session.trackBack = { type: 'recent' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tqh' || action === 'tqn') {
        if (!session.currentTrack) return;
        session.busy = true;
        const quality = action === 'tqh' ? 'hq' : 'normal';
        const statusText = quality === 'hq'
          ? (session.currentTrack?.source === 'ahangify'
              ? 'در حال دریافت بهترین کیفیت موجود…'
              : 'در حال دریافت کیفیت عالی…')
          : 'در حال دریافت کیفیت معمولی…';
        await bot.editMessageText(session.chatId,messageId,statusText);
        sourceQueue.push({ type: 'track_quality', sessionId, quality, messageId });
      } else if (action === 'tly') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال دریافت متن…');
        sourceQueue.push({ type: 'track_lyrics', sessionId, messageId });
      } else if (action === 'tcv') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال دریافت کاور…');
        sourceQueue.push({ type: 'track_cover', sessionId, messageId });
      } else if (action === 'tif') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال دریافت مشخصات…');
        sourceQueue.push({ type: 'track_info', sessionId, messageId });
      } else if (action === 'tar') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن خواننده…');
        sourceQueue.push({ type: 'track_artist', sessionId, messageId });
      } else if (action === 'tal') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آلبوم…');
        sourceQueue.push({ type: 'track_album', sessionId, messageId });
      } else if (action === 'alb') {
        const page = Number(parts[2] || 0);
        if (session.albums) {
          session.albumsPage = page;
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n💿 آلبوم‌ها`,{
            reply_markup: albumsKeyboard(sessionId,session.albums,page),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'در حال دریافت آلبوم‌ها…');
          sourceQueue.push({ type: 'albums', sessionId, page, messageId });
        }
      } else if (action === 'ao') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آلبوم…');
        sourceQueue.push({ type: 'album', sessionId, index: Number(parts[2]), messageId });
      } else if (action === 'apg') {
        if (!session.currentAlbum?.tracks?.length) return;
        session.albumTrackPage = Math.max(0, Number(parts[2] || 0));
        const title = `💿 ${session.currentAlbum.title}\n${session.currentAlbum.artist || session.artistContext?.artist || ''}`;
        const keyboard = session.currentAlbumView === 'track'
          ? trackAlbumKeyboard(
              sessionId,
              session.currentAlbum,
              session.currentAlbum.tracks,
              session.albumTrackPage
            )
          : albumTracksKeyboard(
              sessionId,
              session.currentAlbum.tracks,
              session.albumsPage || 0,
              session.albumTrackPage,
              { backAction: session.currentAlbumView === 'search' ? 'results' : 'albums' }
            );
        await bot.editMessageText(session.chatId,messageId,title,{ reply_markup: keyboard });
      } else if (action === 'alt') {
        const track = session.currentAlbum?.tracks?.[Number(parts[2])]; if (!track) return;
        session.currentTrack = { ...track, source: track.source || 'melobot' };
        session.trackBack = { type: 'album' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن آهنگ…');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'ala') {
        if (!session.currentAlbum?.tracks?.length) return;
        session.busy = true;
        const count = session.currentAlbum.tracks.length;
        await bot.editMessageText(session.chatId,messageId,`در حال دریافت یکجای آلبوم (${count} آهنگ)…`);
        sourceQueue.push({ type: 'download_album', sessionId, messageId });
      }
    } finally {
      session.expiresAt = Date.now() + (session.busy ? BUSY_SESSION_TTL_MS : SESSION_TTL_MS);
      await sessions.set(sessionId,session);
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (!chatId || !userId) return;
  await noteUserActivity();
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(msg.text || '')) {
    await noteUserActivity();
    await sendHome(chatId, userId);
    return;
  }
  const query = msg.text?.trim();
  if (!query) {
    await bot.sendMessage(chatId,'اسم آهنگ یا خواننده رو به‌صورت متن بفرست.');
    return;
  }
  if (query.startsWith('/')) {
    await bot.sendMessage(chatId,'برای جست‌وجو فقط اسم آهنگ یا خواننده رو بفرست.');
    return;
  }
  if (query.length > 120) {
    await bot.sendMessage(chatId,'عبارت جست‌وجو خیلی طولانیه؛ کوتاه‌ترش کن.');
    return;
  }
  if (!searchAllowed(userId)) {
    await bot.sendMessage(chatId,'یک لحظه صبر کن و دوباره جست‌وجو کن.');
    return;
  }
  if (sourceQueue.size() >= MAX_SOURCE_QUEUE) {
    await bot.sendMessage(chatId,'درخواست‌ها الان زیاده؛ چند لحظه دیگه دوباره امتحان کن.');
    return;
  }
  const status = await bot.sendMessage(chatId,'جست‌وجو…');
  sourceQueue.push({ type: 'search', chatId, userId, query, statusMessageId: status.message_id });
}
