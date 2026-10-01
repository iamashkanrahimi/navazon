import { getArchiveDb } from './archiveDb.js';
import { normalizeText } from './text.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickBestPhoto(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  return photos.reduce((best, p) => {
    if (!best) return p;
    const score = Number(p.width || 0) * Number(p.height || 0);
    const bestScore = Number(best.width || 0) * Number(best.height || 0);
    if (score !== bestScore) return score > bestScore ? p : best;
    return Number(p.file_size || 0) > Number(best.file_size || 0) ? p : best;
  }, null);
}

export async function getArtistProfileImage(artistName = '') {
  const db = getArchiveDb();
  const name = clean(artistName);
  if (!db || !name) return null;

  const key = normalizeText(name);
  const { rows } = await db.query(`
    SELECT
      a.artist_key,
      a.display_name,
      a.farsi_name,
      a.image_url,
      a.image_source,
      a.image_kind,
      m.telegram_file_id,
      m.telegram_file_unique_id,
      m.status AS media_status
    FROM rj_artists a
    LEFT JOIN media_images m ON m.source_url = a.image_url
    WHERE a.image_kind = 'artist_profile'
      AND (
        lower(a.display_name) = lower($1)
        OR lower(COALESCE(a.farsi_name, '')) = lower($1)
        OR lower(COALESCE(a.metadata->>'key', '')) = lower($2)
      )
    ORDER BY
      CASE WHEN lower(a.display_name) = lower($1) THEN 0
           WHEN lower(COALESCE(a.farsi_name, '')) = lower($1) THEN 1
           ELSE 2 END,
      CASE WHEN m.telegram_file_id IS NOT NULL THEN 0 ELSE 1 END,
      a.artist_key
    LIMIT 1
  `, [name, key]);

  return rows[0] || null;
}

async function rememberOnDemandCache(profile, message) {
  if (!profile?.image_url || profile.telegram_file_id) return;
  const db = getArchiveDb();
  if (!db) return;
  const photo = pickBestPhoto(message);
  if (!photo?.file_id) return;

  await db.query(`
    UPDATE media_images
       SET status='cached',
           telegram_file_id=$2,
           telegram_file_unique_id=$3,
           width=$4,
           height=$5,
           file_size=$6,
           telegram_message_id=$7,
           cached_at=now(),
           next_attempt_at=NULL,
           last_error=NULL,
           updated_at=now()
     WHERE source_url=$1
       AND usage_types ? 'artist_image'
  `, [
    profile.image_url,
    photo.file_id,
    photo.file_unique_id || null,
    photo.width || null,
    photo.height || null,
    photo.file_size || null,
    message?.message_id || null,
  ]);
}

export function artistHomeCaption(artist = '') {
  const name = clean(artist);
  return `🎤 ${name}\n\nاز کجا شروع کنیم؟`;
}

async function retireArtistProfileMessage(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
    return 'deleted';
  } catch (err) {
    const msg = String(err?.message || err);
    if (/message to delete not found|MESSAGE_ID_INVALID/i.test(msg)) {
      return 'gone';
    }
    if (!/message can't be deleted/i.test(msg)) {
      console.warn('[artist profile photo delete]', msg);
    }

    // A stale Artist card with live inline buttons can mutate the current
    // session after navigation has moved elsewhere. If Telegram refuses to
    // delete the old card, disable its keyboard so it becomes harmless.
    try {
      await bot.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
      return 'disabled';
    } catch (markupErr) {
      console.warn(
        '[artist profile stale keyboard]',
        String(markupErr?.message || markupErr)
      );
      return 'retained';
    }
  }
}

export async function clearArtistProfilePhoto(bot, session) {
  const id = Number(session?.artistPhotoMessageId || 0);
  if (!id || !session?.chatId) {
    if (session) {
      session.artistPhotoMessageId = null;
      session.artistProfileArtistKey = null;
      session.artistProfileVisible = false;
    }
    return;
  }
  try {
    await retireArtistProfileMessage(bot, session.chatId, id);
  } finally {
    session.artistPhotoMessageId = null;
    session.artistProfileArtistKey = null;
    session.artistProfileVisible = false;
  }
}

export async function replaceArtistProfileCardWithText(
  bot,
  session,
  currentMessageId,
  text = 'یه لحظه…',
  extra = {}
) {
  const photoId = Number(session?.artistPhotoMessageId || 0);
  const currentId = Number(currentMessageId || 0);

  // Old sessions used a separate photo + text control message. In that case,
  // remove only the companion photo and keep using the existing text message.
  if (!photoId || photoId !== currentId) {
    await clearArtistProfilePhoto(bot, session);
    return currentId || Number(session?.messageId || 0);
  }

  // Create the replacement first. If Telegram is temporarily unavailable,
  // the existing Artist card remains usable instead of disappearing.
  const replacement = await bot.sendMessage(session.chatId, text, {
    disable_notification: true,
    ...extra,
  });
  session.messageId = replacement.message_id;
  await clearArtistProfilePhoto(bot, session);
  return replacement.message_id;
}

export async function renderArtistHomePage(
  bot,
  sessionId,
  session,
  messageId,
  keyboard
) {
  const artist = clean(session?.artistContext?.artist);
  if (!artist) throw new Error('Artist context missing.');

  const caption = artistHomeCaption(artist);
  const currentIsCard = Number(session?.artistPhotoMessageId || 0) === Number(messageId || 0);
  const profile = await getArtistProfileImage(artist).catch(err => {
    console.warn('[artist profile lookup]', artist, err?.message || err);
    return null;
  });

  if (!profile?.image_url) {
    if (currentIsCard) {
      const replacementId = await replaceArtistProfileCardWithText(
        bot,
        session,
        messageId,
        caption,
        { reply_markup: keyboard }
      );
      session.messageId = replacementId;
      return null;
    }

    await clearArtistProfilePhoto(bot, session);
    const result = await bot.editMessageText(
      session.chatId,
      messageId,
      caption,
      { reply_markup: keyboard }
    );
    session.messageId = messageId;
    session.artistProfileVisible = false;
    return result;
  }

  // The new Artist surface is a single Telegram photo card: image, title and
  // keyboard live together. Follow/unfollow can update the same card in place.
  if (currentIsCard && session.artistProfileArtistKey === profile.artist_key) {
    try {
      const result = await bot.editMessageCaption(
        session.chatId,
        messageId,
        caption,
        { reply_markup: keyboard }
      );
      session.messageId = messageId;
      session.artistProfileVisible = true;
      return result;
    } catch (err) {
      console.warn('[artist profile card edit]', artist, err?.message || err);
    }
  }

  // If an in-place card edit failed, keep the current card until a new
  // photo card has been sent successfully. For legacy two-message sessions,
  // the companion image can still be cleared before replacement.
  const preserveCurrentCard = currentIsCard;
  if (!preserveCurrentCard) {
    await clearArtistProfilePhoto(bot, session);
  }
  const photoInput = profile.telegram_file_id || profile.image_url;
  let photoMessage = null;
  try {
    photoMessage = await bot.sendPhoto(session.chatId, photoInput, {
      caption,
      reply_markup: keyboard,
      disable_notification: true,
    });

    if (Number(messageId || 0) && Number(messageId) !== Number(photoMessage.message_id)) {
      await retireArtistProfileMessage(bot, session.chatId, messageId);
    }

    session.artistPhotoMessageId = photoMessage.message_id;
    session.artistProfileArtistKey = profile.artist_key;
    session.artistProfileVisible = true;
    session.messageId = photoMessage.message_id;

    if (!profile.telegram_file_id) {
      rememberOnDemandCache(profile, photoMessage).catch(err =>
        console.warn('[artist profile on-demand cache]', err?.message || err)
      );
    }
    return photoMessage;
  } catch (err) {
    if (photoMessage?.message_id) {
      try { await bot.deleteMessage(session.chatId, photoMessage.message_id); } catch {}
    }
    console.warn('[artist profile render fallback]', artist, err?.message || err);

    if (preserveCurrentCard) {
      // The previous card is still present and interactive. Prefer that safe
      // fallback over replacing it with a second orphaned control message.
      session.messageId = Number(messageId || 0) || session.messageId;
      session.artistProfileVisible = true;
      return null;
    }

    const fallbackId = Number(messageId || 0) || Number(session.messageId || 0);
    if (fallbackId) {
      try {
        const result = await bot.editMessageText(
          session.chatId,
          fallbackId,
          caption,
          { reply_markup: keyboard }
        );
        session.messageId = fallbackId;
        session.artistProfileVisible = false;
        return result;
      } catch {}
    }

    const result = await bot.sendMessage(
      session.chatId,
      caption,
      { reply_markup: keyboard, disable_notification: true }
    );
    session.messageId = result.message_id;
    session.artistProfileVisible = false;
    return result;
  }
}
