import { config } from './config.js';
import { bot, bridge, cache, tg } from './runtime.js';
import { applyPolicyDefaults, canDeliverTrack } from './policy.js';
import { forwardHiddenToOurBot, forwardHiddenManyToOurBot } from './mtproto.js';
import { minimalBrandCaption, MAX_RESULTS } from './ui.js';
import { searchMeloBot, downloadMeloBotTrack } from './sources/melobot.js';
import { searchAhangify, downloadAhangifyResult } from './sources/ahangify.js';

function splitAhangifyTitle(value = '') {
  const text = String(value).replace(/\s+/g,' ').trim();
  const match = text.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (!match) return { artist: '', title: text };
  return { artist: match[1].trim(), title: match[2].trim() };
}

export function sourceCandidateToTrack(candidate) {
  if (candidate.source === 'melobot') return candidate;
  const parsed = splitAhangifyTitle(candidate.title);
  return applyPolicyDefaults({ ...candidate, artist: parsed.artist, title: parsed.title });
}

export function assertDeliveryAllowed(track, userRegion = 'unknown') {
  const decision = canDeliverTrack(track,userRegion);
  if (!decision.allowed) {
    const err = new Error('REGION_RESTRICTED_IRAN_ONLY');
    err.code = 'REGION_RESTRICTED_IRAN_ONLY';
    throw err;
  }
  return decision.track;
}

export async function deliverCached(chatId, track, cached) {
  const caption = minimalBrandCaption();
  if (cached.kind === 'document') await bot.sendDocument(chatId,cached.fileId,{ caption });
  else await bot.sendAudio(chatId,cached.fileId,{
    caption,
    ...(track.title ? { title: track.title } : {}),
    ...(track.artist ? { performer: track.artist } : {}),
    ...(cached.duration ? { duration: cached.duration } : {}),
  });
  await cache.recordServe(track,{ cacheHit: true, cacheKey: cached._cacheKey || null });
}

export async function bridgeSourceMessage(sourceUsername, audioMessage, track) {
  const mediaPromise = bridge.expectMedia(25_000);
  await forwardHiddenToOurBot(tg,sourceUsername,audioMessage.id);
  const media = await mediaPromise;
  await cache.set(track,media,{ sourceFetch: true });
  return media;
}

export async function bridgeSourceAudio(sourceUsername, result, track) {
  return bridgeSourceMessage(sourceUsername,result.audioMessage,track);
}

export async function bridgeSourceMessages(sourceUsername, messages = []) {
  const ids = (messages || []).map(message => Number(message?.id)).filter(Number.isFinite);
  if (!ids.length) return { items: [], complete: true, expected: 0 };

  const timeoutMs = Math.max(35_000, Math.min(120_000, 12_000 + ids.length * 4_000));
  const wait = bridge.expectManyMedia(ids.length, timeoutMs);
  await forwardHiddenManyToOurBot(tg, sourceUsername, ids);
  return wait;
}

export async function sendMedia(chatId, track, media) {
  const caption = minimalBrandCaption();
  if (media.kind === 'audio') await bot.sendAudio(chatId,media.fileId,{
    caption,
    ...(track.title ? { title: track.title } : media.title ? { title: media.title } : {}),
    ...(track.artist ? { performer: track.artist } : media.performer ? { performer: media.performer } : {}),
    ...(media.duration ? { duration: media.duration } : {}),
  });
  else await bot.sendDocument(chatId,media.fileId,{ caption });
  await cache.recordServe(track,{ cacheHit: false });
}

function normalizeMatch(value = '') {
  return String(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chooseAhangifyMatch(results, track) {
  const wantedArtist = normalizeMatch(track?.artist || '');
  const wantedTitle = normalizeMatch(track?.title || '');
  let best = null;
  let bestScore = -1;

  for (const candidate of results || []) {
    const parsed = sourceCandidateToTrack({ ...candidate, source: 'ahangify' });
    const artist = normalizeMatch(parsed.artist || '');
    const title = normalizeMatch(parsed.title || '');

    const titleScore = !wantedTitle
      ? 0
      : title === wantedTitle
        ? 2
        : (title && (title.includes(wantedTitle) || wantedTitle.includes(title)) ? 1 : 0);

    const artistScore = !wantedArtist
      ? 0
      : artist === wantedArtist
        ? 2
        : (artist && (artist.includes(wantedArtist) || wantedArtist.includes(artist)) ? 1 : 0);

    if (wantedTitle && titleScore === 0) continue;
    if (wantedArtist && artistScore === 0) continue;

    const score = titleScore * 10 + artistScore * 8;
    if (score > bestScore) {
      bestScore = score;
      best = { candidate, parsed };
    }
  }

  return best;
}

export async function downloadTrackWithSources(track, originalQuery) {
  const cached = await cache.get(track);
  if (cached) return { cached, track };

  if (track.source === 'ahangify' && track.cmd) {
    const result = await downloadAhangifyResult(tg, track);
    return {
      media: await bridgeSourceAudio(config.ahangifyUsername, result, track),
      track,
    };
  }

  if (track.source === 'melobot') {
    try {
      const result = await downloadMeloBotTrack(tg,track);
      return { media: await bridgeSourceAudio(config.melobotUsername,result,track), track };
    } catch (err) {
      console.warn('[melobot download]',err.message);
    }
  }

  const fallbackQuery = [track.artist,track.title].filter(Boolean).join(' ') || originalQuery;
  const results = await searchAhangify(tg,fallbackQuery);
  const matched = chooseAhangifyMatch(results, track);
  if (!matched) throw new Error('Fallback source returned no sufficiently close result.');

  const result = await downloadAhangifyResult(tg,matched.candidate);
  const finalTrack = track.artist || track.title ? track : matched.parsed;
  return {
    media: await bridgeSourceAudio(config.ahangifyUsername,result,finalTrack),
    track: finalTrack,
  };
}

export async function searchPrimary(query) {
  try {
    const tracks = await searchMeloBot(tg,query);
    return tracks.slice(0,MAX_RESULTS).map(track => applyPolicyDefaults({ ...track, source: 'melobot' }));
  } catch (err) {
    console.warn('[melobot search]',err.message);
    const results = await searchAhangify(tg,query);
    return results.slice(0,MAX_RESULTS).map(candidate => applyPolicyDefaults({
      ...sourceCandidateToTrack({ ...candidate, source: 'ahangify' }), source: 'ahangify',
    }));
  }
}
