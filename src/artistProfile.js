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

export async function clearArtistProfilePhoto(bot, session) {
  const id = Number(session?.artistPhotoMessageId || 0);
  if (!id || !session?.chatId) {
    if (session) session.artistPhotoMessageId = null;
    return;
  }
  try {
    await bot.deleteMessage(session.chatId, id);
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/message to delete not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(msg)) {
      console.warn('[artist profile photo delete]', msg);
    }
  } finally {
    session.artistPhotoMessageId = null;
    session.artistProfileArtistKey = null;
  }
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

  await clearArtistProfilePhoto(bot, session);
  const profile = await getArtistProfileImage(artist).catch(err => {
    console.warn('[artist profile lookup]', artist, err?.message || err);
    return null;
  });

  if (!profile?.image_url) {
    const result = await bot.editMessageText(
      session.chatId,
      messageId,
      artist,
      { reply_markup: keyboard }
    );
    session.messageId = messageId;
    session.artistProfileVisible = false;
    return result;
  }

  const photoInput = profile.telegram_file_id || profile.image_url;
  let photoMessage = null;
  let controlMessage = null;
  try {
    photoMessage = await bot.sendPhoto(session.chatId, photoInput, {
      disable_notification: true,
    });
    controlMessage = await bot.sendMessage(
      session.chatId,
      artist,
      { reply_markup: keyboard, disable_notification: true }
    );

    try {
      await bot.deleteMessage(session.chatId, messageId);
    } catch (err) {
      console.warn('[artist profile replace old control]', err?.message || err);
    }

    session.artistPhotoMessageId = photoMessage.message_id;
    session.artistProfileArtistKey = profile.artist_key;
    session.artistProfileVisible = true;
    session.messageId = controlMessage.message_id;

    if (!profile.telegram_file_id) {
      rememberOnDemandCache(profile, photoMessage).catch(err =>
        console.warn('[artist profile on-demand cache]', err?.message || err)
      );
    }
    return controlMessage;
  } catch (err) {
    if (photoMessage?.message_id && !controlMessage?.message_id) {
      try { await bot.deleteMessage(session.chatId, photoMessage.message_id); } catch {}
    }
    console.warn('[artist profile render fallback]', artist, err?.message || err);
    const result = await bot.editMessageText(
      session.chatId,
      messageId,
      artist,
      { reply_markup: keyboard }
    );
    session.messageId = messageId;
    session.artistProfileVisible = false;
    return result;
  }
}
