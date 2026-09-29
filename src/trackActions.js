import { config } from './config.js';
import { bot, bridge, cache, deepCatalog, tg } from './runtime.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import { assertDeliveryAllowed } from './media.js';
import { minimalBrandCaption, trackPageKeyboard, trackPageTitle } from './ui.js';
import {
  downloadMeloBotTrackQuality,
  getMeloBotCover,
  getMeloBotLyrics,
  getMeloBotTrackMetadata,
  inspectMeloBotTrack,
  sanitizeMeloBotLyricsText,
} from './sources/melobot.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function captureForwardedMedia(message) {
  if (!message?.id) throw new Error('Source media message is missing.');
  const wait = bridge.expectMedia(25_000);
  await forwardHiddenToOurBot(tg, config.melobotUsername, message.id);
  return wait;
}

export async function prepareTrackPage(track) {
  await deepCatalog.upsertTrack(track, { discoveredFrom: 'user:track-page' });
  try { await deepCatalog.seedTrackTasks(track, { priority: 118 }); } catch {}

  let details = await deepCatalog.getTrackDetails(track);
  const snapshot = details?.metadata?.capabilities || {};
  const checkedAt = Date.parse(details?.metadata?.capabilitiesCheckedAt || '') || 0;
  const snapshotFresh = checkedAt > 0 && (Date.now() - checkedAt) < 7 * 24 * 60 * 60 * 1000;

  let capabilities = {
    hasHq: Boolean(details?.media?.hq) || Boolean(snapshot.hasHq) || track?.source === 'ahangify',
    hasNormal: Boolean(details?.media?.normal) || Boolean(snapshot.hasNormal),
    hasLyrics: Boolean(details?.lyrics_text) || Boolean(snapshot.hasLyrics),
    hasCover: Boolean(details?.cover_file_id) || Boolean(snapshot.hasCover),
    hasMetadata: Boolean(
      details?.release_date || details?.release_date_raw || details?.duration_seconds ||
      details?.popularity_count || details?.popularity_text || details?.albumInfo ||
      snapshot.hasMetadata
    ),
    hasArtistPage: Boolean(track?.artist),
  };

  if (!snapshotFresh && track?.source === 'melobot' && track?.rawText) {
    try {
      const live = await inspectMeloBotTrack(tg, track);
      capabilities = {
        hasHq: capabilities.hasHq || live.hasHq,
        hasNormal: capabilities.hasNormal || live.hasNormal,
        hasLyrics: capabilities.hasLyrics || live.hasLyrics,
        hasCover: capabilities.hasCover || live.hasCover,
        hasMetadata: capabilities.hasMetadata || live.hasMetadata,
        hasArtistPage: capabilities.hasArtistPage || live.hasArtistPage,
      };
      try { await deepCatalog.setCapabilities(track, capabilities); } catch {}
    } catch (err) {
      console.warn('[track page inspect]', err.message);
    }
  }

  details = await deepCatalog.getTrackDetails(track);
  return { details, capabilities };
}

export async function renderTrackPage(sessionId, session, messageId) {
  const track = session.currentTrack;
  if (!track) throw new Error('Current track is missing.');
  const page = await prepareTrackPage(track);
  session.trackDetails = page.details;
  session.trackCapabilities = page.capabilities;
  await bot.editMessageText(
    session.chatId,
    messageId,
    trackPageTitle(track),
    { reply_markup: trackPageKeyboard(sessionId, track, page.details, page.capabilities) }
  );
}

async function sendAudioMedia(chatId, track, media) {
  if (media.kind === 'document') {
    await bot.sendDocument(chatId, media.fileId, { caption: minimalBrandCaption() });
    return;
  }
  await bot.sendAudio(chatId, media.fileId, {
    caption: minimalBrandCaption(),
    ...(track.title ? { title: track.title } : {}),
    ...(track.artist ? { performer: track.artist } : {}),
    ...(media.duration ? { duration: media.duration } : {}),
  });
}

export async function sendTrackQuality(chatId, track, quality, userRegion = 'unknown') {
  assertDeliveryAllowed(track, userRegion);
  let details = await deepCatalog.getTrackDetails(track);
  let media = details?.media?.[quality] || null;
  let cacheHit = Boolean(media);
  let cacheKey = null;

  if (!media) {
    // Quality buttons are strict: a legacy untyped file-cache entry is never
    // promoted to HQ. HQ/normal reuse comes only from deep_track_media where
    // the quality dimension is explicit.
    if (track?.source === 'melobot' && track?.rawText) {
      const result = await downloadMeloBotTrackQuality(tg, track, quality);
      media = await captureForwardedMedia(result.audioMessage);
      await deepCatalog.setMedia(track, quality, media, { source: 'melobot' });
      if (quality === 'hq') {
        await cache.set(track, media, { sourceFetch: true });
      }
    } else if (quality === 'hq') {
      const { downloadTrackWithSources } = await import('./media.js');
      const outcome = await downloadTrackWithSources(
        track,
        [track.artist, track.title].filter(Boolean).join(' '),
        { allowLegacyCache: false }
      );
      media = outcome.cached || outcome.media;
      if (outcome.cached) {
        cacheHit = true;
        cacheKey = outcome.cached._cacheKey || null;
      }
      if (media) {
        await deepCatalog.setMedia(track, 'hq', media, {
          source: track.source || 'ahangify',
          bitrate: Number(track.bitrate || 0) || undefined,
        });
      }
    } else {
      throw new Error('Requested quality is not available for this track source.');
    }
  }

  await sendAudioMedia(chatId, track, media);
  try { await cache.recordServe(track, { cacheHit, cacheKey }); } catch {}
  return media;
}

function chunks(text, max = 3800) {
  const input = String(text || '').trim();
  if (!input) return [];
  const out = [];
  let rest = input;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.55)) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendTrackLyrics(chatId, track) {
  let details = await deepCatalog.getTrackDetails(track);
  let lyrics = details?.lyrics_text || '';

  // Old cached rows may still contain the MeloBot footer. Clean them on read
  // and write the sanitized copy back so the database self-heals.
  if (lyrics) {
    const cleaned = sanitizeMeloBotLyricsText(lyrics, track);
    if (cleaned !== lyrics) {
      lyrics = cleaned;
      if (lyrics) {
        try { await deepCatalog.setLyrics(track, lyrics, details?.lyrics_source || 'melobot'); } catch {}
      }
    }
  }

  if (!lyrics && track?.source === 'melobot' && track?.rawText) {
    const result = await getMeloBotLyrics(tg, track);
    if (result.available && result.text) {
      lyrics = result.text;
      await deepCatalog.setLyrics(track, lyrics, 'melobot');
    } else {
      await deepCatalog.markNoLyrics(track, 'melobot');
    }
  }

  if (!lyrics) {
    await bot.sendMessage(chatId, 'متن این آهنگ موجود نیست.');
    return false;
  }

  const parts = chunks(lyrics);
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = index === 0 ? `📝 ${trackPageTitle(track)}\n\n` : '';
    await bot.sendMessage(chatId, `${prefix}${parts[index]}`);
  }
  return true;
}

export async function sendTrackCover(chatId, track) {
  let details = await deepCatalog.getTrackDetails(track);
  let media = details?.cover_file_id ? {
    kind: 'photo',
    fileId: details.cover_file_id,
    fileUniqueId: details.cover_unique_id || undefined,
  } : null;

  if (!media && track?.source === 'melobot' && track?.rawText) {
    const cover = await getMeloBotCover(tg, track);
    if (cover?.photoMessage) {
      media = await captureForwardedMedia(cover.photoMessage);
      if (media.kind === 'photo') {
        await deepCatalog.setCover(track, media);
      }
    }
  }

  if (!media?.fileId) {
    await bot.sendMessage(chatId, 'کاور این آهنگ موجود نیست.');
    return false;
  }

  await bot.sendPhoto(chatId, media.fileId, { caption: trackPageTitle(track) });
  return true;
}

export async function getTrackInfoText(track) {
  let details = await deepCatalog.getTrackDetails(track);
  const needsLive = !details?.release_date && !details?.release_date_raw &&
    !details?.popularity_count && !details?.popularity_text;

  if (needsLive && track?.source === 'melobot' && track?.rawText) {
    try {
      const patch = await getMeloBotTrackMetadata(tg, track);
      await deepCatalog.setMetadata(track, patch);
      details = await deepCatalog.getTrackDetails(track);
    } catch (err) {
      console.warn('[track info]', err.message);
    }
  }

  const lines = [`📋 ${trackPageTitle(track)}`];
  if (details?.albumInfo?.title) lines.push(`💿 آلبوم: ${details.albumInfo.title}`);
  if (details?.release_date) lines.push(`📅 تاریخ انتشار: ${details.release_date}`);
  else if (details?.release_date_raw) lines.push(`📅 تاریخ انتشار: ${details.release_date_raw}`);
  if (details?.duration_seconds) {
    const min = Math.floor(details.duration_seconds / 60);
    const sec = String(details.duration_seconds % 60).padStart(2, '0');
    lines.push(`⏱ مدت: ${min}:${sec}`);
  }
  if (details?.popularity_text) lines.push(`📈 بازدید حدودی: ${details.popularity_text}`);
  else if (details?.popularity_count) lines.push(`📈 بازدید حدودی: ${Number(details.popularity_count).toLocaleString('en-US')}`);

  const qualities = Object.keys(details?.media || {});
  if (qualities.length) {
    const labels = qualities.map(q =>
      q === 'hq'
        ? (track?.source === 'ahangify' ? 'بهترین کیفیت منبع' : 'عالی')
        : q === 'normal'
          ? 'معمولی'
          : q
    );
    lines.push(`🎧 کیفیت‌های موجود: ${labels.join('، ')}`);
  }

  if (lines.length === 1) lines.push('اطلاعات بیشتری برای این آهنگ ثبت نشده.');
  return lines.join('\n');
}

export async function getTrackAlbum(track) {
  const details = await deepCatalog.getTrackDetails(track);
  if (!details?.albumInfo?.album_key) return null;
  const tracks = await deepCatalog.getAlbumTracksByKey(details.albumInfo.album_key);
  return {
    album: {
      albumKey: details.albumInfo.album_key,
      title: details.albumInfo.title,
      artist: details.albumInfo.artist,
      trackCount: details.albumInfo.track_count,
    },
    tracks,
  };
}
