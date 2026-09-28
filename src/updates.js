import { bot, bridge, follows, sessions } from './runtime.js';
import { sourceQueue, showResults } from './jobs.js';
import {
  SESSION_TTL_MS, TOP_TRACKS_LIMIT,
  artistHomeKeyboard, artistSongsKeyboard, albumsKeyboard,
} from './ui.js';
import { setState } from './state.js';

function validSession(callback, session) {
  return session && session.expiresAt > Date.now() && callback.from?.id === session.userId;
}

async function noteUserActivity() {
  await setState('last_user_activity_at',{ at: Date.now() });
}

export async function handleUpdate(update) {
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

      if (action === 't') {
        const track = session.options[Number(parts[2])]; if (!track) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,`دریافت «${track.title}»…`);
        sourceQueue.push({ type: 'download', sessionId, track, messageId });
      } else if (action === 'ar') {
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,'در حال باز کردن خواننده…');
        sourceQueue.push({ type: 'artist', sessionId, messageId });
      } else if (action === 'rs') {
        await showResults(sessionId,session,messageId);
      } else if (action === 'arh' && session.artistContext) {
        await bot.editMessageText(session.chatId,messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(sessionId,session.artistContext,session.isFollowing),
        });
      } else if (action === 'fol' && session.artistContext) {
        session.isFollowing = await follows.toggle(session.userId,session.artistContext.artist);
        await bot.editMessageText(session.chatId,messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(sessionId,session.artistContext,session.isFollowing),
        });
      } else if (action === 'ars' && session.artistContext) {
        await bot.editMessageText(session.chatId,messageId,`${session.artistContext.artist}\n🎵 پربازدیدترین آهنگ‌ها`,{
          reply_markup: artistSongsKeyboard(sessionId,session.artistContext.tracks),
        });
      } else if (action === 'ata' && session.artistContext?.tracks?.length) {
        session.busy = true;
        const count = Math.min(TOP_TRACKS_LIMIT,session.artistContext.tracks.length);
        await bot.editMessageText(session.chatId,messageId,`در حال دریافت ${count} آهنگ برتر…`);
        sourceQueue.push({ type: 'download_top', sessionId, messageId });
      } else if (action === 'at') {
        const track = session.artistContext?.tracks?.[Number(parts[2])]; if (!track) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,`دریافت «${track.title}»…`);
        sourceQueue.push({ type: 'download', sessionId, track: { ...track, source: 'melobot' }, messageId });
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
      } else if (action === 'alt') {
        const track = session.currentAlbum?.tracks?.[Number(parts[2])]; if (!track) return;
        session.busy = true;
        await bot.editMessageText(session.chatId,messageId,`دریافت «${track.title}»…`);
        sourceQueue.push({ type: 'download', sessionId, track: { ...track, source: 'melobot' }, messageId });
      }
    } finally {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await sessions.set(sessionId,session);
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  if (bridge.consumeBotMessage(msg)) return;

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (!chatId || !userId) return;
  await noteUserActivity();
  if (msg.text === '/start') {
    await bot.sendMessage(chatId,'اسم آهنگ یا خواننده رو بفرست.');
    return;
  }
  const query = msg.text?.trim();
  if (!query) {
    await bot.sendMessage(chatId,'اسم آهنگ یا خواننده رو به‌صورت متن بفرست.');
    return;
  }
  const status = await bot.sendMessage(chatId,'جست‌وجو…');
  sourceQueue.push({ type: 'search', chatId, userId, query, statusMessageId: status.message_id });
}
