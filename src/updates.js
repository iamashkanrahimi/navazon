import { randomBytes } from 'node:crypto';
import { bot, bridge, follows, sessions } from './runtime.js';
import {
  sourceQueue,
  showResults,
  tryHandleCachedSearch,
  tryOpenTrackArtistLocal,
  tryOpenArtistListLocal,
  tryOpenAlbumsLocal,
  tryOpenAlbumLocal,
  tryDeliverBulkFromCacheLocal,
} from './jobs.js';
import {
  SESSION_TTL_MS, BUSY_SESSION_TTL_MS, TOP_TRACKS_LIMIT,
  homeKeyboard, newestMenuKeyboard, topMenuKeyboard,
  curatedPlaylistsKeyboard, followedArtistsKeyboard,
  artistHomeKeyboard, artistSongsKeyboard, albumsKeyboard,
  albumTracksKeyboard, trackAlbumKeyboard,
} from './ui.js';
import { noteUserActivity } from './state.js';
import { CURATED_PLAYLISTS } from './homeCatalog.js';
import {
  renderArtistHomePage,
  clearArtistProfilePhoto,
  replaceArtistProfileCardWithText,
} from './artistProfile.js';
import {
  getTrackInfoText,
  renderTrackPage,
  trySendCachedTrackQuality,
  trySendCachedTrackLyrics,
  trySendCachedTrackCover,
  getTrackAlbum,
} from './trackActions.js';

const lastSearchAt = new Map();
const SEARCH_COOLDOWN_MS = 1000;
const MAX_SOURCE_QUEUE = 30;
const BULK_SOURCE_TYPES = new Set(['download_top', 'download_recent', 'download_album']);
const HOME_TEXT = '🎧 Navazon\n\nچی می‌خوای گوش بدی؟\nاسم آهنگ، خواننده یا آلبوم رو بفرست.';

function queueSessionSource(sessionId, session, job) {
  return sourceQueue.push({
    ...job,
    sessionId,
    userId: session?.userId,
  });
}

async function cancelQueuedBulkForUser(userId, currentSessionId = null) {
  const removed = sourceQueue.removeWhere(item =>
    String(item?.userId || '') === String(userId || '')
    && BULK_SOURCE_TYPES.has(item?.type)
  );
  if (removed.length) {
    console.log(
      `[queue supersede] user=${userId} removed_bulk=${removed.length}`
    );
    await Promise.allSettled(removed.map(async item => {
      if (!item?.sessionId) return;
      const staleSession = await sessions.get(item.sessionId);
      if (!staleSession) return;
      staleSession.busy = false;
      staleSession.expiresAt = Date.now() + SESSION_TTL_MS;
      await sessions.set(item.sessionId, staleSession);
      if (item.messageId) {
        try {
          await bot.editMessageText(
            staleSession.chatId,
            item.messageId,
            'درخواست قبلی رو کنار گذاشتم و رفتم سراغ جدیدش.'
          );
        } catch {}
      }
    }));
  }
  return {
    count: removed.length,
    currentSessionCancelled: Boolean(
      currentSessionId
      && removed.some(item => String(item?.sessionId || '') === String(currentSessionId))
    ),
  };
}


function artistChoicesFromCredit(value = '') {
  return [...new Set(
    String(value || '')
      .split(/\s*(?:&|\bx\b|,|feat\.?|ft\.?|featuring)\s*/iu)
      .map(part => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  )];
}

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
      'این آهنگ این بار باز نشد؛ یه بار دیگه امتحان کن.'
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
    HOME_TEXT,
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
      await bot.answerCallbackQuery(callback.id,{ text: 'این صفحه دیگه فعّال نیست؛ یه جست‌وجوی تازه بزن 🔎' });
      return;
    }
    try {
      // Any newer callback from the same user supersedes an older queued
      // bulk request, including a newer bulk request from another session.
      // This runs before the new callback can enqueue work, so it cannot cancel
      // the request currently being created.
      const cancelled = await cancelQueuedBulkForUser(session.userId, sessionId);
      if (cancelled.currentSessionCancelled) session.busy = false;

      if (session.busy) {
        await bot.answerCallbackQuery(callback.id,{ text: 'هنوز دارم قبلی رو انجام می‌دم…' });
        return;
      }
      let messageId = callback.message?.message_id || session.messageId;
      await bot.answerCallbackQuery(callback.id);
      await noteUserActivity();

      // Artist home can be a single photo card. Before navigating away, replace
      // that card with a text control message so every existing editMessageText
      // route remains safe. Old two-message Artist sessions are also supported.
      if (session.artistPhotoMessageId && action !== 'fol') {
        const currentIsCard =
          Number(session.artistPhotoMessageId) === Number(messageId);
        if (currentIsCard) {
          messageId = await replaceArtistProfileCardWithText(
            bot,
            session,
            messageId,
            'یه لحظه…'
          );
        } else {
          await clearArtistProfilePhoto(bot, session);
        }
      }

      if (action === 'hmn') {
        session.busy = false;
        session.resultsBackAction = null;
        session.resultsBackText = null;
        await bot.editMessageText(
          session.chatId,
          messageId,
          HOME_TEXT,
          { reply_markup: homeKeyboard(sessionId) }
        );
      } else if (action === 'hnew') {
        await bot.editMessageText(
          session.chatId,
          messageId,
          '🔥 تازه‌ها\nکدوم حال‌و‌هوا؟',
          { reply_markup: newestMenuKeyboard(sessionId) }
        );
      } else if (action === 'htop') {
        await bot.editMessageText(
          session.chatId,
          messageId,
          '🏆 پردانلودها\nچه بازه‌ای؟',
          { reply_markup: topMenuKeyboard(sessionId) }
        );
      } else if (action === 'hnc' || action === 'htc') {
        session.busy = true;
        const feedKey = parts[2];
        await bot.editMessageText(session.chatId, messageId, 'دارم آهنگ‌ها رو میارم… 🎵');
        queueSessionSource(sessionId, session, { type: 'home_feed', messageId, feedKey });
      } else if (action === 'hpl') {
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          messageId,
          '🎧 پلی‌لیست‌ها\nیه مود انتخاب کن 👇',
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
        await bot.editMessageText(session.chatId, messageId, 'دارم پلی‌لیست رو میارم… 🎧');
        queueSessionSource(sessionId, session, {
          type: 'home_playlist',
          messageId,
          playlistKey: playlist.key,
        });
      } else if (action === 'hfol') {
        session.followedArtists = await follows.listForUser(session.userId, 12);
        if (!session.followedArtists.length) {
          await bot.editMessageText(
            session.chatId,
            messageId,
            '♡ دنبال‌شده‌ها\n\nهنوز کسی رو دنبال نمی‌کنی 👀\n\nاز صفحه‌ی هر خواننده می‌تونی روی «♡ دنبال کردن» بزنی.',
            { reply_markup: followedArtistsKeyboard(sessionId, []) }
          );
        } else {
          await bot.editMessageText(
            session.chatId,
            messageId,
            '♡ دنبال‌شده‌ها',
            { reply_markup: followedArtistsKeyboard(sessionId, session.followedArtists) }
          );
        }
      } else if (action === 'hfa') {
        const index = Number(parts[2]);
        if (!session.followedArtists?.[index]) return;
        session.busy = true;
        await bot.editMessageText(session.chatId, messageId, 'دارم صفحه‌ی خواننده رو باز می‌کنم… 🎤');
        queueSessionSource(sessionId, session, { type: 'home_artist', messageId, index });
      } else if (action === 't') {
        const track = session.options[Number(parts[2])]; if (!track) return;
        session.currentTrack = track;
        session.trackBack = { type: 'results' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'یه لحظه، دارم بازش می‌کنم… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'sal') {
        const album = session.albumOptions?.[Number(parts[2])]; if (!album) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم آلبوم رو باز می‌کنم… 💿');
        queueSessionSource(sessionId, session, {
          type: 'search_album',
          messageId,
          index: Number(parts[2]),
        });
      } else if (action === 'ar') {
        const seedIndex = Number(parts[2]);
        const seed = session.options?.[seedIndex];
        const artistChoices = artistChoicesFromCredit(seed?.artist || '');
        if (artistChoices.length > 1) {
          session.artistChoices = artistChoices;
          session.artistChoiceSeedIndex = seedIndex;
          session.busy = false;
          await bot.editMessageText(
            session.chatId,
            messageId,
            'صفحه‌ی کدوم خواننده رو باز کنم؟',
            {
              reply_markup: {
                inline_keyboard: [
                  ...artistChoices.map((artist, index) => ([{
                    text: `🎤 ${artist}`,
                    callback_data: `arc:${sessionId}:${index}`,
                  }])),
                  [{ text: '↩️ برگشت', callback_data: `rs:${sessionId}` }],
                ],
              },
            }
          );
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'دارم صفحه‌ی خواننده رو باز می‌کنم… 🎤');
          queueSessionSource(sessionId, session, {
            type: 'artist',
            messageId,
            seedIndex,
          });
        }
      } else if (action === 'arc') {
        const artist = session.artistChoices?.[Number(parts[2])];
        if (!artist) return;
        session.busy = true;
        await bot.editMessageText(
          session.chatId,
          messageId,
          `دارم صفحه‌ی ${artist} رو باز می‌کنم… 🎤`
        );
        queueSessionSource(sessionId, session, {
          type: 'artist',
          artistOverride: artist,
          seedIndex: Number(session.artistChoiceSeedIndex),
          messageId,
        });
      } else if (action === 'aar') {
        const albumIndex = Number(parts[2]);
        const album = session.albumOptions?.[albumIndex];
        if (!album?.artist) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم صفحه‌ی خواننده رو باز می‌کنم… 🎤');
        queueSessionSource(sessionId, session, {
          type: 'artist_from_album',
          messageId,
          albumIndex,
        });
      } else if (action === 'rs') {
        await showResults(sessionId,session,messageId);
      } else if (action === 'trt') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم برمی‌گردم به آهنگ… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tret') {
        if (session.albumOriginTrack) {
          session.currentTrack = session.albumOriginTrack;
          session.trackBack = session.albumOriginBack || { type: 'results' };
        }
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم برمی‌گردم به آهنگ… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tbk') {
        const back = session.trackBack || { type: 'results' };
        if (back.type === 'top' && session.artistContext) {
          const tracks = session.artistContext.topTracks || [];
          await bot.editMessageText(session.chatId,messageId,`🔥 پربازدیدهای ${session.artistContext.artist}`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'top' }),
          });
        } else if (back.type === 'recent' && session.artistContext) {
          const tracks = session.artistContext.recentTracks || [];
          await bot.editMessageText(session.chatId,messageId,`🆕 تازه‌های ${session.artistContext.artist}`,{
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
        await renderArtistHomePage(
          bot,
          sessionId,
          session,
          messageId,
          artistHomeKeyboard(
            sessionId,
            session.artistContext,
            session.isFollowing,
            { backAction: session.artistBack || 'rs' }
          )
        );
      } else if (action === 'fol' && session.artistContext) {
        session.isFollowing = await follows.toggle(session.userId,session.artistContext.artist);
        await renderArtistHomePage(
          bot,
          sessionId,
          session,
          messageId,
          artistHomeKeyboard(
            sessionId,
            session.artistContext,
            session.isFollowing,
            { backAction: session.artistBack || 'rs' }
          )
        );
      } else if (action === 'ars' && session.artistContext) {
        const tracks = session.artistContext.topTracks || [];
        if (tracks.length) {
          await bot.editMessageText(session.chatId,messageId,`🔥 پربازدیدهای ${session.artistContext.artist}`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'top' }),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'دارم پربازدیدها رو میارم… 🔥');
          const openedLocal = await tryOpenArtistListLocal(
            sessionId,
            session,
            messageId,
            'top'
          ).catch(() => false);
          if (!openedLocal) {
            queueSessionSource(sessionId, session, { type: 'artist_list', mode: 'top', messageId });
          }
        }
      } else if (action === 'arn' && session.artistContext) {
        const tracks = session.artistContext.recentTracks || [];
        if (tracks.length) {
          await bot.editMessageText(session.chatId,messageId,`🆕 تازه‌های ${session.artistContext.artist}`,{
            reply_markup: artistSongsKeyboard(sessionId,tracks,{ mode: 'recent' }),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'دارم تازه‌ها رو میارم… 🆕');
          const openedLocal = await tryOpenArtistListLocal(
            sessionId,
            session,
            messageId,
            'recent'
          ).catch(() => false);
          if (!openedLocal) {
            queueSessionSource(sessionId, session, { type: 'artist_list', mode: 'recent', messageId });
          }
        }
      } else if (action === 'ata' && session.artistContext?.topTracks?.length) {
        session.busy = true;
        const tracks = session.artistContext.topTracks || [];
        const count = Math.min(TOP_TRACKS_LIMIT,tracks.length);
        await bot.editMessageText(session.chatId,messageId,`دارم ${count} آهنگ رو می‌فرستم…`);
        const servedLocal = await tryDeliverBulkFromCacheLocal(
          sessionId,
          session,
          messageId,
          'top'
        ).catch(() => false);
        if (!servedLocal) {
          queueSessionSource(sessionId, session, { type: 'download_top', messageId });
        }
      } else if (action === 'rta' && session.artistContext?.recentTracks?.length) {
        session.busy = true;
        const count = Math.min(TOP_TRACKS_LIMIT,session.artistContext.recentTracks.length);
        await bot.editMessageText(session.chatId,messageId,`دارم ${count} آهنگ رو می‌فرستم…`);
        const servedLocal = await tryDeliverBulkFromCacheLocal(
          sessionId,
          session,
          messageId,
          'recent'
        ).catch(() => false);
        if (!servedLocal) {
          queueSessionSource(sessionId, session, { type: 'download_recent', messageId });
        }
      } else if (action === 'at') {
        const tracks = session.artistContext?.topTracks || [];
        const track = tracks[Number(parts[2])]; if (!track) return;
        session.currentTrack = { ...track, source: track.source || 'melobot' };
        session.trackBack = { type: 'top' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'یه لحظه، دارم بازش می‌کنم… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'rt') {
        const track = session.artistContext?.recentTracks?.[Number(parts[2])]; if (!track) return;
        session.currentTrack = { ...track, source: track.source || 'melobot' };
        session.trackBack = { type: 'recent' };
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'یه لحظه، دارم بازش می‌کنم… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tqh' || action === 'tqn') {
        if (!session.currentTrack) return;
        session.busy = true;
        const quality = action === 'tqh' ? 'hq' : 'normal';
        const statusText = quality === 'hq'
          ? 'دارم آهنگ رو می‌فرستم…'
          : 'در حال دریافت کیفیت معمولی…';
        await bot.editMessageText(session.chatId,messageId,statusText);
        let servedFromCache = false;
        try {
          servedFromCache = await trySendCachedTrackQuality(
            session.chatId,
            session.currentTrack,
            quality,
            session.userRegion || 'unknown'
          );
        } catch (err) {
          if (err?.code === 'REGION_RESTRICTED_IRAN_ONLY') {
            await bot.sendMessage(
              session.chatId,
              'این آهنگ فعلاً فقط داخل ایران در دسترسه 🇮🇷'
            );
            await openTrackPageLocal(sessionId, session, messageId);
            servedFromCache = true;
          }
        }
        if (servedFromCache) {
          if (session.busy) await openTrackPageLocal(sessionId, session, messageId);
        } else {
          queueSessionSource(sessionId, session, { type: 'track_quality', quality, messageId });
        }
      } else if (action === 'tly') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم متنش رو پیدا می‌کنم… 📝');
        const servedLyrics = await trySendCachedTrackLyrics(
          session.chatId,
          session.currentTrack
        ).catch(() => false);
        if (servedLyrics) {
          await openTrackPageLocal(sessionId, session, messageId);
        } else {
          queueSessionSource(sessionId, session, { type: 'track_lyrics', messageId });
        }
      } else if (action === 'tcv') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم کاورش رو میارم… 🖼');
        const servedCover = await trySendCachedTrackCover(
          session.chatId,
          session.currentTrack
        ).catch(() => false);
        if (servedCover) {
          await openTrackPageLocal(sessionId, session, messageId);
        } else {
          queueSessionSource(sessionId, session, { type: 'track_cover', messageId });
        }
      } else if (action === 'tif') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم اطلاعاتش رو میارم…');
        try {
          const text = await getTrackInfoText(session.currentTrack);
          await bot.sendMessage(session.chatId, text);
        } catch (err) {
          console.error('[track info local]', err.message);
          await bot.sendMessage(session.chatId, 'فعلاً اطلاعات بیشتری از این آهنگ ندارم.');
        }
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'tar') {
        if (!session.currentTrack) return;
        const artistChoices = artistChoicesFromCredit(session.currentTrack.artist);
        if (artistChoices.length > 1) {
          session.artistChoices = artistChoices;
          session.busy = false;
          await bot.editMessageText(
            session.chatId,
            messageId,
            'صفحه‌ی کدوم خواننده رو باز کنم؟',
            {
              reply_markup: {
                inline_keyboard: [
                  ...artistChoices.map((artist, index) => ([{
                    text: `🎤 ${artist}`,
                    callback_data: `tac:${sessionId}:${index}`,
                  }])),
                  [{ text: '↩️ برگشت', callback_data: `trt:${sessionId}` }],
                ],
              },
            }
          );
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'دارم صفحه‌ی خواننده رو باز می‌کنم… 🎤');
          const openedLocal = await tryOpenTrackArtistLocal(
            sessionId,
            session,
            messageId
          ).catch(() => false);
          if (!openedLocal) {
            queueSessionSource(sessionId, session, { type: 'track_artist', messageId });
          }
        }
      } else if (action === 'tac') {
        const artist = session.artistChoices?.[Number(parts[2])];
        if (!artist || !session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(
          session.chatId,
          messageId,
          `دارم صفحه‌ی ${artist} رو باز می‌کنم… 🎤`
        );
        queueSessionSource(sessionId, session, {
          type: 'track_artist',
          artistOverride: artist,
          messageId,
        });
      } else if (action === 'tal') {
        if (!session.currentTrack) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم آلبوم رو باز می‌کنم… 💿');
        const albumData = await getTrackAlbum(session.currentTrack).catch(() => null);
        if (albumData?.album && albumData.tracks?.length) {
          session.albumOriginTrack = session.currentTrack;
          session.albumOriginBack = session.trackBack;
          session.currentAlbum = { ...albumData.album, tracks: albumData.tracks };
          session.currentAlbumView = 'track';
          session.albumTrackPage = 0;
          session.busy = false;
          await bot.editMessageText(
            session.chatId,
            messageId,
            `💿 ${albumData.album.title}\n${albumData.album.artist || session.currentTrack.artist}`,
            {
              reply_markup: trackAlbumKeyboard(
                sessionId,
                albumData.album,
                albumData.tracks,
                0
              ),
            }
          );
        } else {
          queueSessionSource(sessionId, session, { type: 'track_album', messageId });
        }
      } else if (action === 'alb') {
        const page = Number(parts[2] || 0);
        if (session.albums) {
          session.albumsPage = page;
          await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n💿 آلبوم‌ها`,{
            reply_markup: albumsKeyboard(sessionId,session.albums,page),
          });
        } else {
          session.busy = true;
          await bot.editMessageText(session.chatId,messageId,'دارم آلبوم‌ها رو میارم… 💿');
          const openedLocal = await tryOpenAlbumsLocal(
            sessionId,
            session,
            messageId,
            page
          ).catch(() => false);
          if (!openedLocal) {
            queueSessionSource(sessionId, session, { type: 'albums', page, messageId });
          }
        }
      } else if (action === 'ao') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'دارم آلبوم رو باز می‌کنم… 💿');
        const openedLocal = await tryOpenAlbumLocal(
          sessionId,
          session,
          messageId,
          Number(parts[2])
        ).catch(() => false);
        if (!openedLocal) {
          queueSessionSource(sessionId, session, { type: 'album', index: Number(parts[2]), messageId });
        }
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
        await bot.editMessageText(session.chatId,messageId,'یه لحظه، دارم بازش می‌کنم… 🎵');
        await openTrackPageLocal(sessionId, session, messageId);
      } else if (action === 'ala') {
        if (!session.currentAlbum?.tracks?.length) return;
        session.busy = true;
        const count = session.currentAlbum.tracks.length;
        await bot.editMessageText(session.chatId,messageId,`دارم ${count} آهنگ آلبوم رو می‌فرستم…`);
        const servedLocal = await tryDeliverBulkFromCacheLocal(
          sessionId,
          session,
          messageId,
          'album'
        ).catch(() => false);
        if (!servedLocal) {
          queueSessionSource(sessionId, session, { type: 'download_album', messageId });
        }
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
    await bot.sendMessage(chatId,'اسم آهنگ، خواننده یا آلبوم رو برام بنویس 🎵');
    return;
  }
  if (query.startsWith('/')) {
    await bot.sendMessage(chatId,'برای جست‌وجو فقط اسم آهنگ، خواننده یا آلبوم رو بفرست.');
    return;
  }
  if (query.length > 120) {
    await bot.sendMessage(chatId,'یکم کوتاه‌ترش کن تا بهتر پیداش کنم 🔎');
    return;
  }
  if (!searchAllowed(userId)) {
    await bot.sendMessage(chatId,'یه لحظه صبر کن، بعد دوباره بگردیم 🔎');
    return;
  }
  // A new explicit query supersedes queued bulk work from the same user.
  // Removing only pending bulk jobs keeps the shared MeloBot lane responsive
  // without cancelling another user's active request or ordinary navigation.
  await cancelQueuedBulkForUser(userId);

  const status = await bot.sendMessage(chatId,'دارم می‌گردم… 🔎');
  const servedFromCache = await tryHandleCachedSearch(
    chatId,
    userId,
    query,
    status.message_id
  ).catch(() => false);
  if (!servedFromCache) {
    if (sourceQueue.size() >= MAX_SOURCE_QUEUE) {
      await bot.editMessageText(
        chatId,
        status.message_id,
        'الان یه کم شلوغه 😅 چند ثانیه دیگه دوباره بزن.'
      );
      return;
    }
    sourceQueue.push({
      type: 'search',
      chatId,
      userId,
      query,
      statusMessageId: status.message_id,
    });
  }
}
