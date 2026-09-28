import { config } from './config.js';
import { bot, bridge, cache, tg } from './runtime.js';
import { applyPolicyDefaults, canDeliverTrack } from './policy.js';
import { forwardHiddenToOurBot } from './mtproto.js';
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
  await cache.recordServe(track,{ cacheHit: true });
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

export async function downloadTrackWithSources(track, originalQuery) {
  const cached = await cache.get(track);
  if (cached) return { cached, track };
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
  const chosen = results[0];
  if (!chosen) throw new Error('Fallback source returned no result.');
  const ahTrack = sourceCandidateToTrack({ ...chosen, source: 'ahangify' });
  const result = await downloadAhangifyResult(tg,chosen);
  const finalTrack = track.artist || track.title ? track : ahTrack;
  return { media: await bridgeSourceAudio(config.ahangifyUsername,result,finalTrack), track: finalTrack };
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
