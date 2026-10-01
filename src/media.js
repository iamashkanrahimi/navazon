import { config } from './config.js';
import { bot, bridge, cache, deepCatalog, tg } from './runtime.js';
import { applyPolicyDefaults, canDeliverTrack } from './policy.js';
import { forwardHiddenToOurBot, forwardHiddenManyToOurBot } from './mtproto.js';
import { minimalBrandCaption, MAX_RESULTS } from './ui.js';
import {
  normalizeText,
  rankTracksForQuery,
  meaningfulSearchTokens,
  shouldUseSearchRelevanceFallback,
  primarySearchQueries,
  acceptsShortenedPrimarySearch,
  artistCreditCompatible,
  titleCreditsArtist,
  trackMediaIdentityMatches,
} from './text.js';
import {
  searchMeloBot,
  searchMeloBotTyped,
  classifyMeloBotTypedSearchExact,
  downloadMeloBotTrack,
} from './sources/melobot.js';
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

export function canonicalTrackFromAudioMetadata(track = {}, media = {}) {
  const performer = String(media?.performer || '').replace(/\s+/g, ' ').trim();
  const mediaTitle = String(media?.title || '').replace(/\s+/g, ' ').trim();
  if (!performer) return track;

  // For title-only Album/Artist rows the page title is usually the cleaner
  // catalog identity while Telegram audio metadata is authoritative for the
  // primary performer. For already-explicit rows (including transliterated
  // fallback results), performer + title metadata can repair both fields.
  const title = track?.artistInferred
    ? String(track?.title || mediaTitle).replace(/\s+/g, ' ').trim()
    : (mediaTitle || String(track?.title || '').replace(/\s+/g, ' ').trim());
  if (!title) return track;

  return applyPolicyDefaults({
    ...track,
    artist: performer,
    title,
    artistInferred: false,
  });
}

export function assertMediaIdentityMatchesTrack(track = {}, media = {}) {
  if (trackMediaIdentityMatches(track, media)) return true;
  const err = new Error(
    `Source media identity mismatch: expected ${track?.artist || '?'} — ${track?.title || '?'}; got ${media?.performer || '?'} — ${media?.title || '?'}`
  );
  err.code = 'SOURCE_MEDIA_IDENTITY_MISMATCH';
  throw err;
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
    ...(track.artist && !track.artistInferred
      ? { performer: track.artist }
      : cached.performer
        ? { performer: cached.performer }
        : {}),
    ...(cached.duration ? { duration: cached.duration } : {}),
  });
  if (!track?.artistInferred) {
    await cache.recordServe(track,{ cacheHit: true, cacheKey: cached._cacheKey || null });
  }
}

export async function bridgeSourceMessage(
  sourceUsername,
  audioMessage,
  track,
  { timeoutMs = 10_000 } = {}
) {
  const mediaPromise = bridge.expectMedia(
    Math.max(3_000, Math.min(15_000, Number(timeoutMs || 10_000)))
  );
  await forwardHiddenToOurBot(tg,sourceUsername,audioMessage.id);
  const media = await mediaPromise;
  assertMediaIdentityMatchesTrack(track, media);

  const originalTrack = { ...track };
  const durableTrack = canonicalTrackFromAudioMetadata(track, media);

  if (
    durableTrack?.artist
    && durableTrack?.title
    && (
      normalizeText(durableTrack.artist) !== normalizeText(originalTrack.artist || '')
      || normalizeText(durableTrack.title) !== normalizeText(originalTrack.title || '')
    )
  ) {
    try {
      await deepCatalog.setTrackAlias(originalTrack, durableTrack, {
        source: originalTrack.source || sourceUsername,
        evidence: 'telegram_audio_metadata',
      });
    } catch (err) {
      console.warn('[track alias learn]', err.message);
    }
    Object.assign(track, durableTrack);
  }

  if (!durableTrack?.artistInferred) {
    await cache.set(durableTrack,media,{ sourceFetch: true });
  }
  return media;
}

export async function bridgeSourceAudio(
  sourceUsername,
  result,
  track,
  { timeoutMs = 10_000 } = {}
) {
  return bridgeSourceMessage(
    sourceUsername,
    result.audioMessage,
    track,
    { timeoutMs }
  );
}

export async function bridgeSourceMessages(
  sourceUsername,
  messages = [],
  { timeoutMs = null } = {}
) {
  const ids = (messages || []).map(message => Number(message?.id)).filter(Number.isFinite);
  if (!ids.length) return { items: [], complete: true, expected: 0 };

  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(3_000, Math.min(10_000, timeoutMs))
    : Math.max(8_000, Math.min(15_000, 5_000 + ids.length * 1_000));
  const wait = bridge.expectManyMedia(ids.length, waitMs);
  await forwardHiddenManyToOurBot(tg, sourceUsername, ids);
  return wait;
}

export async function sendMedia(
  chatId,
  track,
  media,
  { cacheHit = false, cacheKey = null } = {}
) {
  const caption = minimalBrandCaption();
  if (media.kind === 'audio') await bot.sendAudio(chatId,media.fileId,{
    caption,
    ...(track.title ? { title: track.title } : media.title ? { title: media.title } : {}),
    ...(track.artist && !track.artistInferred
      ? { performer: track.artist }
      : media.performer
        ? { performer: media.performer }
        : {}),
    ...(media.duration ? { duration: media.duration } : {}),
  });
  else await bot.sendDocument(chatId,media.fileId,{ caption });
  if (!track?.artistInferred) {
    await cache.recordServe(track,{ cacheHit, cacheKey });
  }
}

function normalizeMatch(value = '') {
  return normalizeText(value);
}

function interactionBudget(timeoutMs = Math.min(config.searchTimeoutMs, 14000)) {
  const total = Math.max(2500, Number(timeoutMs || 14000));
  const deadline = Date.now() + total;
  const remaining = () => Math.max(800, deadline - Date.now());
  remaining.expired = () => Date.now() >= deadline;
  return remaining;
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
      : (
          artistCreditCompatible(track?.artist || '', parsed.artist || '')
          || titleCreditsArtist(parsed.title || '', track?.artist || '')
        )
        ? 2
        : 0;

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

export async function downloadTrackWithSources(
  track,
  originalQuery,
  {
    allowLegacyCache = true,
    totalTimeoutMs = 22000,
  } = {}
) {
  const remaining = interactionBudget(totalTimeoutMs);

  if (allowLegacyCache && !track?.artistInferred) {
    const cached = await cache.get(track);
    if (cached) return { cached, track };
  }

  if (track.source === 'ahangify' && track.cmd) {
    const result = await downloadAhangifyResult(
      tg,
      track,
      { timeoutMs: Math.min(10000, remaining()) }
    );
    if (remaining.expired()) throw new Error('Interactive download budget exhausted.');
    return {
      media: await bridgeSourceAudio(
        config.ahangifyUsername,
        result,
        track,
        { timeoutMs: Math.min(7000, remaining()) }
      ),
      track,
    };
  }

  if (track.source === 'melobot') {
    try {
      const result = await downloadMeloBotTrack(
        tg,
        track,
        { timeoutMs: Math.min(10000, remaining()) }
      );
      if (remaining.expired()) throw new Error('Interactive download budget exhausted.');
      return {
        media: await bridgeSourceAudio(
          config.melobotUsername,
          result,
          track,
          { timeoutMs: Math.min(7000, remaining()) }
        ),
        track,
      };
    } catch (err) {
      console.warn('[melobot download]',err.message);
    }
  }

  const fallbackQuery = [track?.artist, track?.title].filter(Boolean).join(' ')
    || track?.title
    || originalQuery;
  if (remaining.expired()) {
    throw new Error('Interactive fallback search budget exhausted.');
  }
  const results = await searchAhangify(tg, fallbackQuery, {
    timeoutMs: Math.min(6000, remaining()),
  });
  const matched = chooseAhangifyMatch(results, track);
  if (!matched) throw new Error('Fallback source returned no sufficiently close result.');

  if (remaining.expired()) {
    throw new Error('Interactive fallback download budget exhausted.');
  }
  const result = await downloadAhangifyResult(
    tg,
    matched.candidate,
    { timeoutMs: Math.min(8000, remaining()) }
  );
  const finalTrack = track.artist || track.title ? track : matched.parsed;
  if (remaining.expired()) {
    throw new Error('Interactive fallback bridge budget exhausted.');
  }
  return {
    media: await bridgeSourceAudio(
      config.ahangifyUsername,
      result,
      finalTrack,
      { timeoutMs: Math.min(6000, remaining()) }
    ),
    track: finalTrack,
  };
}

export async function searchPrimaryTyped(
  query,
  { timeoutMs = Math.min(config.searchTimeoutMs, 14000) } = {}
) {
  const remaining = interactionBudget(timeoutMs);
  try {
    let typed = null;
    let lastMeloError = null;
    for (const sourceQuery of primarySearchQueries(query)) {
      if (remaining.expired()) break;
      try {
        const raw = await searchMeloBotTyped(tg, sourceQuery, {
          timeoutMs: Math.min(
            sourceQuery === query ? 7000 : 3600,
            remaining()
          ),
        });
        const candidateTyped = await classifyMeloBotTypedSearchExact(
          tg,
          sourceQuery,
          raw,
          {
            probeTimeoutMs: Math.min(2200, remaining()),
          }
        );

        // Keep a shortened feat query only when its Track rows still cover the
        // user's full intent. Otherwise try the original wording before
        // settling for the shorter fallback.
        if (
          sourceQuery !== query
          && !acceptsShortenedPrimarySearch(
            query,
            sourceQuery,
            candidateTyped.tracks || []
          )
        ) {
          // Never retain an under-specified shortened result as the final
          // answer. It is useful only as a cheap probe; if the full query and
          // fallback source both fail, returning the base song would violate
          // the user's explicit featured/collaboration intent.
          continue;
        }

        typed = candidateTyped;
        if (typed.tracks?.length || typed.albums?.length) break;
      } catch (err) {
        lastMeloError = err;
      }
    }
    if (!typed) throw lastMeloError || new Error('MeloBot typed search returned no usable results.');

    const rankedMelo = rankTracksForQuery(query, typed.tracks || []);
    const meaningful = meaningfulSearchTokens(query);
    let selectedMelo = rankedMelo;

    // Complex queries such as "Shayea Ma Ft T-Dey" should not degrade into
    // a partial artist/title match merely because two tokens happen to match.
    // If MeloBot does not cover every meaningful query token, blend in the
    // fallback source and re-rank the combined candidates.
    const bestCoverage = rankedMelo[0]?.coverage || 0;
    const needsRelevanceFallback = shouldUseSearchRelevanceFallback(
      query,
      bestCoverage,
      rankedMelo[0]?.track || null,
      typed.tracks || []
    );

    if (needsRelevanceFallback) {
      try {
        if (remaining.expired()) {
          throw new Error('Search relevance fallback budget exhausted.');
        }
        const fallback = await searchAhangify(tg, query, {
          timeoutMs: remaining(),
        });
        const fallbackTracks = fallback.map(candidate => applyPolicyDefaults({
          ...sourceCandidateToTrack({ ...candidate, source: 'ahangify' }),
          source: 'ahangify',
        }));
        const combined = [
          ...rankedMelo.map(item => applyPolicyDefaults({ ...item.track, source: 'melobot' })),
          ...fallbackTracks,
        ];
        const seen = new Set();
        selectedMelo = rankTracksForQuery(query, combined)
          .filter(item => {
            const key = `${normalizeText(item.track.artist || '')}|${normalizeText(item.track.title || '')}`;
            if (!key || key === '|' || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      } catch (err) {
        console.warn('[search relevance fallback]', err.message);
      }
    }

    const tracks = selectedMelo
      .slice(0, MAX_RESULTS)
      .map(item => applyPolicyDefaults({
        ...item.track,
        source: item.track.source || 'melobot',
      }));

    const albums = (typed.albums || [])
      .filter(album => album?.artist && album?.title)
      .slice(0, MAX_RESULTS)
      .map(album => ({ ...album, source: 'melobot' }));

    if (tracks.length || albums.length) {
      const trackSources = new Set(tracks.map(track => track.source).filter(Boolean));
      const resultSource = trackSources.size > 1
        ? 'hybrid'
        : (trackSources.values().next().value || 'melobot');

      return {
        tracks,
        albums,
        source: resultSource,
        typed: true,
        exactProbe: typed.exactProbe || 'not_needed',
        relevanceCoverage: selectedMelo[0]?.coverage || 0,
      };
    }

    throw new Error('MeloBot typed search returned no visible results.');
  } catch (err) {
    console.warn('[melobot search]', err.message);
    if (remaining.expired()) throw err;
    const results = await searchAhangify(tg, query, {
      timeoutMs: remaining(),
    });
    return {
      tracks: results.slice(0, MAX_RESULTS).map(candidate => applyPolicyDefaults({
        ...sourceCandidateToTrack({ ...candidate, source: 'ahangify' }),
        source: 'ahangify',
      })),
      albums: [],
      source: 'ahangify',
      typed: false,
    };
  }
}

export async function searchPrimary(query) {
  return (await searchPrimaryTyped(query)).tracks;
}
