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
  resolveMeloBotTrackCandidate,
  sanitizeMeloBotLyricsText,
} from './sources/melobot.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function hasCanonicalTrackIdentity(track = {}) {
  return Boolean(track?.artist && track?.title && !track?.artistInferred);
}

function trackPageHeading(track = {}) {
  const title = clean(track?.title || '') || 'آهنگ';
  const artist = track?.artistInferred ? '' : clean(track?.artist || '');
  return [`🎵 ${title}`, artist].filter(Boolean).join('\n');
}

function trackCaption(track = {}) {
  const artist = track?.artistInferred ? '' : clean(track?.artist || '');
  const title = clean(track?.title || '');
  return `🎵 ${[artist, title].filter(Boolean).join(' — ') || 'آهنگ'}`;
}

const CAPABILITY_TTL_MS = 60 * 60 * 1000;

function freshCapabilitySnapshot(details = {}) {
  const checkedAt = Date.parse(details?.metadata?.capabilitiesCheckedAt || '');
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > CAPABILITY_TTL_MS) {
    return {};
  }
  return details?.metadata?.capabilities || {};
}

async function resolveKnownAliasInPlace(track = {}) {
  if (!hasCanonicalTrackIdentity(track)) return track;
  try {
    const resolved = await deepCatalog.resolveTrackAlias(track);
    if (resolved && resolved !== track) Object.assign(track, resolved);
  } catch (err) {
    console.warn('[track alias]', err.message);
  }
  return track;
}

function adoptCanonicalCandidate(track = {}, candidate = null) {
  if (
    !candidate?.artist
    || !candidate?.title
    || candidate.artistInferred
  ) {
    return track;
  }

  // Session track objects are mutable by design. Repair them in place so a
  // successful quality/lyrics/cover/info action also fixes later Artist/Album
  // navigation without another identity lookup.
  Object.assign(track, {
    ...candidate,
    source: candidate.source || track.source || 'melobot',
    artistInferred: false,
  });
  return track;
}

async function safeTrackDetails(track = {}) {
  if (!hasCanonicalTrackIdentity(track)) {
    return { media: {}, metadata: {}, albumInfo: null };
  }
  await resolveKnownAliasInPlace(track);
  return await deepCatalog.getTrackDetails(track)
    || { media: {}, metadata: {}, albumInfo: null };
}

async function captureForwardedMedia(message, timeoutMs = 10_000) {
  if (!message?.id) throw new Error('Source media message is missing.');
  const wait = bridge.expectMedia(
    Math.max(3_000, Math.min(15_000, Number(timeoutMs || 10_000)))
  );
  await forwardHiddenToOurBot(tg, config.melobotUsername, message.id);
  return wait;
}

export async function prepareTrackPage(track) {
  // Resolve durable aliases before reading capabilities. This keeps Persian,
  // Latin and fallback-source variants of the same delivered audio on one
  // canonical Track page without a live source round trip.
  if (!track?.artistInferred) {
    await resolveKnownAliasInPlace(track);
    await deepCatalog.upsertTrack(track, { discoveredFrom: 'user:track-page' });
    try { await deepCatalog.seedTrackTasks(track, { priority: 118 }); } catch {}
  }

  const details = track?.artistInferred
    ? { media: {}, metadata: {} }
    : await deepCatalog.getTrackDetails(track);
  const snapshot = freshCapabilitySnapshot(details);

  // Transient delivery failures are diagnostic only and never hide an action.
  // Only a capability absence confirmed on the current live source surface may
  // suppress its button for this session.
  const unavailable = track?.capabilityUnavailable || {};
  const hasStoredInfo = Boolean(
    details?.release_date || details?.release_date_raw || details?.duration_seconds ||
    details?.popularity_count || details?.popularity_text || details?.albumInfo
  );
  const capabilities = {
    hasHq: unavailable.hasHq
      ? false
      : (Boolean(details?.media?.hq) || snapshot.hasHq === true
          || (track?.source === 'ahangify' && Boolean(track?.cmd))
        ? true
        : null),
    hasNormal: unavailable.hasNormal
      ? false
      : (Boolean(details?.media?.normal) || snapshot.hasNormal === true ? true : null),
    hasLyrics: details?.metadata?.hasLyrics === false
      ? false
      : (Boolean(details?.lyrics_text) || snapshot.hasLyrics === true ? true : null),
    hasCover: unavailable.hasCover
      ? false
      : (Boolean(details?.cover_file_id) || snapshot.hasCover === true ? true : null),
    hasMetadata: unavailable.hasMetadata
      ? false
      : (hasStoredInfo || snapshot.hasMetadata === true ? true : null),
    hasArtistPage: unavailable.hasArtistPage
      ? false
      : Boolean(
          track?.artist
          && !track?.artistInferred
          && (
            (track?.source === 'melobot' && track?.rawText)
            || snapshot.hasArtistPage === true
          )
        ),
    snapshotFresh: Object.keys(snapshot).length > 0,
  };

  return { details, capabilities };
}

export async function resolveTrackIdentity(track) {
  await resolveKnownAliasInPlace(track);
  if (
    track?.source !== 'melobot'
    || !track?.rawText
    || !track?.artistInferred
  ) {
    return track;
  }

  try {
    const resolved = await resolveMeloBotTrackCandidate(
      tg,
      track,
      { timeoutMs: 5000, forceIdentity: true }
    );
    if (!resolved?.title || resolved.artistInferred !== false) {
      return track;
    }
    return {
      ...track,
      ...resolved,
      source: 'melobot',
      artistInferred: false,
    };
  } catch (err) {
    console.warn('[track identity]', err.message);
    return track;
  }
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
    trackPageHeading(track),
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
    ...(track.title ? { title: track.title } : media.title ? { title: media.title } : {}),
    ...(track.artist && !track.artistInferred
      ? { performer: track.artist }
      : media.performer
        ? { performer: media.performer }
        : {}),
    ...(media.duration ? { duration: media.duration } : {}),
  });
}

export async function trySendCachedTrackQuality(
  chatId,
  track,
  quality,
  userRegion = 'unknown'
) {
  assertDeliveryAllowed(track, userRegion);
  const details = await safeTrackDetails(track);
  const media = details?.media?.[quality] || null;
  if (!media) return false;

  await sendAudioMedia(chatId, track, media);
  if (hasCanonicalTrackIdentity(track)) {
    try {
      await Promise.all([
        cache.recordServe(track, { cacheHit: true }),
        deepCatalog.clearCapabilityFailure(
          track,
          quality === 'hq' ? 'hasHq' : 'hasNormal'
        ),
      ]);
    } catch {}
  }
  return true;
}

export async function sendTrackQuality(
  chatId,
  track,
  quality,
  userRegion = 'unknown',
  { sourceTimeoutMs = config.downloadTimeoutMs } = {}
) {
  assertDeliveryAllowed(track, userRegion);
  let details = await safeTrackDetails(track);
  let media = details?.media?.[quality] || null;
  let cacheHit = Boolean(media);
  let cacheKey = null;

  if (!media) {
    // Quality buttons are strict: a legacy untyped file-cache entry is never
    // promoted to HQ. HQ/normal reuse comes only from deep_track_media where
    // the quality dimension is explicit.
    if (track?.source === 'melobot' && track?.rawText) {
      try {
        const result = await downloadMeloBotTrackQuality(
          tg,
          track,
          quality,
          {
            timeoutMs: Math.max(4000, Number(sourceTimeoutMs || 0)),
            menuTimeoutMs: 4000,
            deliveryTimeoutMs: 7000,
          }
        );
        track = adoptCanonicalCandidate(track, result.candidate);
        media = await captureForwardedMedia(result.audioMessage);
        if (hasCanonicalTrackIdentity(track)) {
          await deepCatalog.setMedia(track, quality, media, { source: 'melobot' });
          if (quality === 'hq') {
            await cache.set(track, media, { sourceFetch: true });
          }
        }
      } catch (err) {
        const capability = quality === 'hq' ? 'hasHq' : 'hasNormal';
        const confirmedAbsent = err?.code === 'MELOBOT_CAPABILITY_ABSENT';
        if (confirmedAbsent) {
          track.capabilityUnavailable = {
            ...(track.capabilityUnavailable || {}),
            [capability]: true,
          };
        }
        if (hasCanonicalTrackIdentity(track)) {
          try {
            const writes = [
              deepCatalog.markCapabilityFailure(
                track,
                capability,
                `${err?.code || 'SOURCE_ERROR'}: ${err.message}`
              ),
            ];
            if (confirmedAbsent) {
              writes.push(deepCatalog.clearCapability(track, capability));
            }
            await Promise.all(writes);
          } catch {}
        }
        throw err;
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
      if (media && hasCanonicalTrackIdentity(track)) {
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
  if (hasCanonicalTrackIdentity(track)) {
    try {
      await Promise.all([
        cache.recordServe(track, { cacheHit, cacheKey }),
        deepCatalog.clearCapabilityFailure(
          track,
          quality === 'hq' ? 'hasHq' : 'hasNormal'
        ),
      ]);
    } catch {}
  }
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

async function sendLyricsText(chatId, track, lyrics) {
  const parts = chunks(lyrics);
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = index === 0
      ? `📝 متن «${clean(track?.title || 'آهنگ')}»${track?.artist && !track?.artistInferred ? `\n${clean(track.artist)}` : ''}\n\n`
      : '';
    await bot.sendMessage(chatId, `${prefix}${parts[index]}`);
  }
}

export async function trySendCachedTrackLyrics(chatId, track) {
  const details = await safeTrackDetails(track);
  let lyrics = details?.lyrics_text || '';
  if (!lyrics) return false;

  const cleaned = sanitizeMeloBotLyricsText(lyrics, track);
  if (!cleaned) return false;
  if (cleaned !== lyrics && hasCanonicalTrackIdentity(track)) {
    lyrics = cleaned;
    try {
      await deepCatalog.setLyrics(
        track,
        lyrics,
        details?.lyrics_source || 'melobot'
      );
    } catch {}
  } else {
    lyrics = cleaned;
  }

  await sendLyricsText(chatId, track, lyrics);
  if (hasCanonicalTrackIdentity(track)) {
    try { await deepCatalog.clearCapabilityFailure(track, 'hasLyrics'); } catch {}
  }
  return true;
}

export async function trySendCachedTrackCover(chatId, track) {
  const details = await safeTrackDetails(track);
  if (!details?.cover_file_id) return false;

  await bot.sendPhoto(chatId, details.cover_file_id, {
    caption: trackCaption(track),
  });
  if (hasCanonicalTrackIdentity(track)) {
    try { await deepCatalog.clearCapabilityFailure(track, 'hasCover'); } catch {}
  }
  return true;
}

export async function sendTrackLyrics(chatId, track) {
  let details = await safeTrackDetails(track);
  let lyrics = details?.lyrics_text || '';

  // Old cached rows may still contain the MeloBot footer. Clean them on read
  // and write the sanitized copy back so the database self-heals.
  if (lyrics) {
    const cleaned = sanitizeMeloBotLyricsText(lyrics, track);
    if (cleaned !== lyrics) {
      lyrics = cleaned;
      if (lyrics) {
        if (hasCanonicalTrackIdentity(track)) {
          try { await deepCatalog.setLyrics(track, lyrics, details?.lyrics_source || 'melobot'); } catch {}
        }
      }
    }
  }

  if (!lyrics && track?.source === 'melobot' && track?.rawText) {
    try {
      const result = await getMeloBotLyrics(tg, track, {
        timeoutMs: 6500,
        menuTimeoutMs: 4000,
        submenuTimeoutMs: 3000,
        deliveryTimeoutMs: 6500,
      });
      track = adoptCanonicalCandidate(track, result.candidate);
      if (result.available && result.text) {
        lyrics = result.text;
        if (hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.setLyrics(track, lyrics, 'melobot'),
            deepCatalog.clearCapabilityFailure(track, 'hasLyrics'),
          ]);
        }
      } else if (result.checked === true) {
        track.capabilityUnavailable = {
          ...(track.capabilityUnavailable || {}),
          hasLyrics: true,
        };
        if (hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.markNoLyrics(track, 'melobot'),
            deepCatalog.clearCapabilityFailure(track, 'hasLyrics'),
            deepCatalog.clearCapability(track, 'hasLyrics'),
          ]);
        }
      }
    } catch (err) {
      if (hasCanonicalTrackIdentity(track)) {
        try {
          await deepCatalog.markCapabilityFailure(
            track,
            'hasLyrics',
            `${err?.code || 'SOURCE_ERROR'}: ${err.message}`
          );
        } catch {}
      }
      throw err;
    }
  }

  if (!lyrics) {
    await bot.sendMessage(chatId, 'متن این آهنگ رو پیدا نکردم 📝');
    return false;
  }

  await sendLyricsText(chatId, track, lyrics);
  return true;
}

export async function sendTrackCover(chatId, track) {
  if (await trySendCachedTrackCover(chatId, track)) return true;

  let media = null;

  if (!media && track?.source === 'melobot' && track?.rawText) {
    try {
      const cover = await getMeloBotCover(tg, track, {
        timeoutMs: 6500,
        menuTimeoutMs: 4000,
        submenuTimeoutMs: 3000,
        deliveryTimeoutMs: 6500,
      });
      track = adoptCanonicalCandidate(track, cover?.candidate);
      if (cover?.photoMessage) {
        media = await captureForwardedMedia(cover.photoMessage);
        if (media.kind === 'photo' && hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.setCover(track, media),
            deepCatalog.clearCapabilityFailure(track, 'hasCover'),
          ]);
        }
      } else if (cover?.checked === true && cover?.available === false) {
        track.capabilityUnavailable = {
          ...(track.capabilityUnavailable || {}),
          hasCover: true,
        };
        if (hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.clearCapability(track, 'hasCover'),
            deepCatalog.clearCapabilityFailure(track, 'hasCover'),
          ]);
        }
      }
    } catch (err) {
      if (hasCanonicalTrackIdentity(track)) {
        try {
          await deepCatalog.markCapabilityFailure(
            track,
            'hasCover',
            `${err?.code || 'SOURCE_ERROR'}: ${err.message}`
          );
        } catch {}
      }
      throw err;
    }
  }

  if (!media?.fileId) {
    await bot.sendMessage(chatId, 'برای این آهنگ کاوری پیدا نکردم 🖼');
    return false;
  }

  await bot.sendPhoto(chatId, media.fileId, { caption: trackCaption(track) });
  return true;
}

export async function getTrackInfoText(track) {
  const details = await safeTrackDetails(track);

  // Track info is an instant local view. Missing release/popularity fields are
  // enriched by the existing background crawler instead of blocking the user
  // on another serialized MeloBot round-trip.
  const lines = [`ℹ️ ${trackPageTitle(track)}`];
  if (details?.albumInfo?.title) lines.push(`💿 ${details.albumInfo.title}`);
  if (details?.release_date) lines.push(`📅 ${details.release_date}`);
  else if (details?.release_date_raw) lines.push(`📅 ${details.release_date_raw}`);
  if (details?.duration_seconds) {
    const min = Math.floor(details.duration_seconds / 60);
    const sec = String(details.duration_seconds % 60).padStart(2, '0');
    lines.push(`⏱ ${min}:${sec}`);
  }
  if (details?.popularity_text) lines.push(`📈 بازدید تقریبی: ${details.popularity_text}`);
  else if (details?.popularity_count) lines.push(`📈 بازدید تقریبی: ${Number(details.popularity_count).toLocaleString('en-US')}`);

  if (lines.length === 1) lines.push('فعلاً اطلاعات بیشتری از این آهنگ ندارم.');
  return lines.join('\n');
}

export async function getTrackAlbum(track) {
  if (!hasCanonicalTrackIdentity(track)) return null;
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
