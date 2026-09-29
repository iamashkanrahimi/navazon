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

const CAPABILITY_TTL_MS = 60 * 60 * 1000;
const CAPABILITY_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

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
  const recentFailures = track?.artistInferred
    ? {}
    : await deepCatalog.getRecentCapabilityFailures(
        track,
        CAPABILITY_FAILURE_COOLDOWN_MS
      );

  // Cached media/content is authoritative. Source capability snapshots are
  // trusted for only one hour; recent transient failures suppress the matching
  // button for 15 minutes without turning that failure into durable absence.
  const unavailable = {
    ...(track?.capabilityUnavailable || {}),
    ...Object.fromEntries(Object.keys(recentFailures).map(key => [key, true])),
  };
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
    ...(track.title ? { title: track.title } : media.title ? { title: media.title } : {}),
    ...(track.artist && !track.artistInferred
      ? { performer: track.artist }
      : media.performer
        ? { performer: media.performer }
        : {}),
    ...(media.duration ? { duration: media.duration } : {}),
  });
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
          { timeoutMs: sourceTimeoutMs }
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
        track.capabilityUnavailable = {
          ...(track.capabilityUnavailable || {}),
          [capability]: true,
        };
        if (hasCanonicalTrackIdentity(track)) {
          try {
            await Promise.all([
              deepCatalog.clearCapability(track, capability),
              deepCatalog.markCapabilityFailure(track, capability, err.message),
            ]);
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
      const result = await getMeloBotLyrics(tg, track, { timeoutMs: 6000 });
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
        if (hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.markNoLyrics(track, 'melobot'),
            deepCatalog.clearCapabilityFailure(track, 'hasLyrics'),
          ]);
        }
      }
    } catch (err) {
      track.capabilityUnavailable = {
        ...(track.capabilityUnavailable || {}),
        hasLyrics: true,
      };
      if (hasCanonicalTrackIdentity(track)) {
        try {
          await deepCatalog.markCapabilityFailure(track, 'hasLyrics', err.message);
        } catch {}
      }
      throw err;
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
  let details = await safeTrackDetails(track);
  let media = details?.cover_file_id ? {
    kind: 'photo',
    fileId: details.cover_file_id,
    fileUniqueId: details.cover_unique_id || undefined,
  } : null;

  if (!media && track?.source === 'melobot' && track?.rawText) {
    try {
      const cover = await getMeloBotCover(tg, track, { timeoutMs: 6000 });
      track = adoptCanonicalCandidate(track, cover?.candidate);
      if (cover?.photoMessage) {
        media = await captureForwardedMedia(cover.photoMessage);
        if (media.kind === 'photo' && hasCanonicalTrackIdentity(track)) {
          await Promise.all([
            deepCatalog.setCover(track, media),
            deepCatalog.clearCapabilityFailure(track, 'hasCover'),
          ]);
        }
      }
      if (!media?.fileId && hasCanonicalTrackIdentity(track)) {
        await deepCatalog.markCapabilityFailure(track, 'hasCover', 'cover unavailable');
      }
    } catch (err) {
      track.capabilityUnavailable = {
        ...(track.capabilityUnavailable || {}),
        hasCover: true,
      };
      if (hasCanonicalTrackIdentity(track)) {
        try {
          await deepCatalog.markCapabilityFailure(track, 'hasCover', err.message);
        } catch {}
      }
      throw err;
    }
  }

  if (!media?.fileId) {
    track.capabilityUnavailable = {
      ...(track.capabilityUnavailable || {}),
      hasCover: true,
    };
    await bot.sendMessage(chatId, 'کاور این آهنگ موجود نیست.');
    return false;
  }

  await bot.sendPhoto(chatId, media.fileId, { caption: trackPageTitle(track) });
  return true;
}

export async function getTrackInfoText(track) {
  const details = await safeTrackDetails(track);

  // Track info is an instant local view. Missing release/popularity fields are
  // enriched by the existing background crawler instead of blocking the user
  // on another serialized MeloBot round-trip.
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

  const qualitySet = new Set(Object.keys(details?.media || {}));
  const knownCapabilities = freshCapabilitySnapshot(details);
  if (knownCapabilities.hasHq === true) qualitySet.add('hq');
  if (knownCapabilities.hasNormal === true) qualitySet.add('normal');
  const qualities = [...qualitySet];

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
