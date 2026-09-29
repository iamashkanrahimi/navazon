import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { bot, cache, catalog, deepCatalog, follows, sessions, tg } from './runtime.js';
import { SerialQueue } from './queue.js';
import { applyPolicyDefaults } from './policy.js';
import {
  SESSION_TTL_MS, BUSY_SESSION_TTL_MS, TOP_TRACKS_LIMIT, ALBUMS_PER_PAGE, normalize,
  homeKeyboard, newestMenuKeyboard, topMenuKeyboard,
  curatedPlaylistsKeyboard, followedArtistsKeyboard,
  resultsKeyboard, artistHomeKeyboard, artistSongsKeyboard,
  albumsKeyboard, noAlbumsKeyboard, albumsErrorKeyboard, albumTracksKeyboard, trackAlbumKeyboard,
} from './ui.js';
import {
  assertDeliveryAllowed, bridgeSourceAudio, bridgeSourceMessage, bridgeSourceMessages,
  deliverCached, downloadTrackWithSources, searchPrimaryTyped, sendMedia,
  sourceCandidateToTrack, canonicalTrackFromAudioMetadata,
} from './media.js';
import {
  openMeloBotArtist, openMeloBotArtistFresh,
  openMeloBotArtistFast, openMeloBotArtistFastFresh,
  prepareMeloBotBulkTopTracks, prepareMeloBotBulkRecentTracks,
  downloadMeloBotTopTracks, downloadMeloBotRecentTracks, downloadMeloBotAlbumTracks,
  matchBulkAudioToTracks, listMeloBotAlbums, resolveMeloBotAlbums, resolveMeloBotArtistAlbums,
  resolveMeloBotAlbumsFromLiveArtistContext, resolveMeloBotArtistAlbumsDirectFirst,
  resolveMeloBotArtistTrackList,
  albumQueryMatches, discoverMeloBotAlbumsForQuery, discoverMeloBotAlbumsByArtistQuery,
  discoverMeloBotFeed, openMeloBotCuratedPlaylist,
  openMeloBotAlbum, openMeloBotAlbumContext, openMeloBotAlbumByTitle,
  openMeloBotAlbumDirectByTitle, openMeloBotAlbumRobustByTitle,
  downloadMeloBotTrack, discoverMeloBotHome, getMeloBotStateVersion,
} from './sources/melobot.js';
import { searchAhangify } from './sources/ahangify.js';
import { recordCrawlerStart, recordCrawlerFinish, setState } from './state.js';
import { executeDeepTask } from './deepCrawler.js';
import { deepTrackKey } from './deepCatalog.js';
import { HOME_FEEDS, curatedPlaylistByKey } from './homeCatalog.js';
import {
  renderTrackPage,
  sendTrackQuality,
  sendTrackLyrics,
  sendTrackCover,
  getTrackInfoText,
  getTrackAlbum,
  resolveTrackIdentity,
} from './trackActions.js';
import {
  hasAlbumIntent,
  hasSpecificAlbumTitle,
  albumTitleAppearsInQuery,
  shouldUseLiveAlbumDiscovery,
  cleanText,
  meaningfulSearchTokens,
  rankTracksForQuery,
} from './text.js';

function newSessionId() { return randomBytes(4).toString('hex'); }

const BACKGROUND_JOB_TYPES = new Set(['deep_crawl', 'discover', 'discover_bootstrap']);
const SEARCH_CACHE_NAMESPACE = 'v160';

function userSearchCacheKey(query = '') {
  return `${SEARCH_CACHE_NAMESPACE}:${query}`;
}

function artistContextTracks(context = {}) {
  const groups = [
    context.topTracks,
    context.recentTracks,
    context.tracks,
  ];
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const track of group || []) {
      const key = `${normalize(track?.artist || '')}|${normalize(track?.title || '')}`;
      if (!normalize(track?.title || '') || seen.has(key)) continue;
      seen.add(key);
      out.push(track);
    }
  }
  return out;
}

function isUsableArtistContext(context = {}) {
  return Boolean(context?.artist && artistContextTracks(context).length);
}

function keepFullCoverageTracksWhenAvailable(query = '', tracks = []) {
  const tokens = meaningfulSearchTokens(query);
  if (tokens.length < 2 || !(tracks || []).length) return tracks || [];

  const ranked = rankTracksForQuery(query, tracks);
  const full = ranked.filter(item => item.total > 0 && item.coverage === item.total);
  return (full.length ? full : ranked).map(item => item.track);
}

const BULK_JOB_TYPES = new Set(['download_top', 'download_recent', 'download_album']);

function sourceJobPriority(job = {}) {
  if (BACKGROUND_JOB_TYPES.has(job.type)) return 0;
  if (BULK_JOB_TYPES.has(job.type)) return 80;

  // Search is the most time-sensitive source operation: a new query should
  // jump ahead of queued downloads/enrichment, while already-running source
  // work remains bounded by its own end-to-end budget.
  if (job.type === 'search') return 140;

  if (
    [
      'search_album',
      'album',
      'albums',
      'artist',
      'artist_from_album',
      'artist_list',
      'track_artist',
    ].includes(job.type)
  ) return 130;

  if (['track_quality','track_lyrics','track_cover','track_info'].includes(job.type)) return 120;
  if (job.type === 'download') return 110;
  if (job.type?.startsWith('home_')) return 105;
  return 100;
}

function hasPendingForegroundSourceWork() {
  return sourceQueue.hasPending(item =>
    !BACKGROUND_JOB_TYPES.has(item?.type)
    && !BULK_JOB_TYPES.has(item?.type)
  );
}

async function syncArtistContext(artistContext) {
  if (!artistContext?.artist) return false;
  const topTracks = artistContext.topTracks || artistContext.tracks || [];
  const recentTracks = artistContext.recentTracks || [];
  const durableTopTracks = topTracks.filter(track => !track?.artistInferred);
  const durableRecentTracks = recentTracks.filter(track => !track?.artistInferred);

  if (!topTracks.length && !recentTracks.length) {
    console.warn('[artist sync skipped]', artistContext.artist, 'empty track context');
    return false;
  }

  const writes = [
    catalog.recordArtist(artistContext.artist, {
      topTracks: durableTopTracks,
      recentTracks: durableRecentTracks,
      albumButton: artistContext.albumButton || null,
    }),
  ];
  if (durableTopTracks.length) {
    writes.push(deepCatalog.setArtistList(artistContext.artist, 'top', durableTopTracks));
  }
  if (durableRecentTracks.length) {
    writes.push(deepCatalog.setArtistList(artistContext.artist, 'recent', durableRecentTracks));
  }

  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[artist sync]', artistContext.artist, result.reason?.message || result.reason);
    }
  }
  return true;
}

async function syncAlbumIndex(artist, albums = [], {
  complete = true,
  emptyConfirmed = false,
} = {}) {
  if (!artist) return;
  const results = await Promise.allSettled([
    complete
      ? catalog.recordAlbums(artist, albums, { emptyConfirmed })
      : catalog.mergeAlbums(artist, albums),
    ...albums.map(album => deepCatalog.upsertAlbum(artist, album)),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[album index sync]', artist, result.reason?.message || result.reason);
    }
  }
}

async function syncAlbumTracks(artist, album, tracks = []) {
  if (!artist || !album?.title || !tracks.length) return;
  const results = await Promise.allSettled([
    catalog.recordAlbumTracks(artist, album, tracks),
    deepCatalog.setAlbumTracks(artist, album, tracks),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[album track sync]', artist, album.title, result.reason?.message || result.reason);
    }
  }
}

async function resolveArtistAlbumsDirect(artist, { maxAlbums = 30 } = {}) {
  const result = await discoverMeloBotAlbumsByArtistQuery(
    tg,
    `album ${artist}`,
    { maxAlbums }
  );

  const resolvedArtist = result.artist || artist;
  const albums = result.albums || [];
  const complete = Boolean(result.complete);
  const confirmedEmpty = Boolean(result.confirmedEmpty && complete);

  await syncAlbumIndex(resolvedArtist, albums, {
    complete,
    emptyConfirmed: confirmedEmpty,
  });

  return {
    artist: resolvedArtist,
    albums,
    complete,
    confirmedEmpty,
  };
}


function mergeAlbumResults(limit, ...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const album of group || []) {
      if (!album?.artist || !album?.title) continue;
      const key = `${normalize(album.artist)}|${normalize(album.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(album);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function searchAlbumOptions(query, tracks = []) {
  const albumIntent = hasAlbumIntent(query);
  const limit = albumIntent ? 20 : 4;

  const [deepAlbums, legacyAlbums] = await Promise.all([
    deepCatalog.searchAlbums(query, limit).catch(err => {
      console.warn('[deep album search]', err.message);
      return [];
    }),
    catalog.searchAlbums(query, limit).catch(err => {
      console.warn('[catalog album search]', err.message);
      return [];
    }),
  ]);
  let albums = mergeAlbumResults(limit, deepAlbums, legacyAlbums);

  // If the catalog already contains a fresh full album list for the one
  // artist matched by this query, serve it without touching MeloBot.
  if (albumIntent && albums.length) {
    const artists = [...new Set(albums.map(album => album.artist).filter(Boolean))];
    if (artists.length === 1) {
      const fullCached = await catalog.getAlbums(
        artists[0],
        config.catalogAlbumsTtlMs,
        config.catalogEmptyAlbumsTtlMs
      ).catch(() => null);
      if (Array.isArray(fullCached) && fullCached.length) {
        const fullRows = fullCached.map(album => ({
          ...album,
          artist: artists[0],
          source: 'catalog',
        }));
        const specificAlbum = hasSpecificAlbumTitle(
          query,
          artists[0],
          fullRows.map(album => album.title)
        );
        const visible = specificAlbum
          ? fullRows.filter(album =>
              albumTitleAppearsInQuery(query, album.title)
              || albumQueryMatches(query, artists[0], album.title)
            )
          : fullRows;

        return mergeAlbumResults(limit, visible, albums);
      }
    }
  }

  // Explicit "album + artist" queries should work even when track search
  // returns no usable MeloBot seed. Resolve the source's artist picker directly.
  if (shouldUseLiveAlbumDiscovery(query)) {
    try {
      const direct = await discoverMeloBotAlbumsByArtistQuery(tg, query, {
        maxAlbums: limit,
      });
      if (direct.artist) {
        await syncAlbumIndex(direct.artist, direct.albums, {
          complete: Boolean(direct.complete),
          emptyConfirmed: Boolean(direct.confirmedEmpty && direct.complete),
        });

        const matched = direct.albums.filter(album =>
          albumTitleAppearsInQuery(query, album.title)
          || albumQueryMatches(query, direct.artist, album.title)
        );
        const specificAlbum = hasSpecificAlbumTitle(
          query,
          direct.artist,
          direct.albums.map(album => album.title)
        );
        const visible = specificAlbum ? matched : direct.albums;

        albums = mergeAlbumResults(
          limit,
          visible.map(album => ({ ...album, artist: direct.artist, source: 'melobot' })),
          albums
        );
      }
    } catch (err) {
      console.warn('[direct album search]', err.message);
    }
  }

  // Ordinary track/artist searches must stay instant. They may show album
  // suggestions already present in the catalogs above, but they never spend a
  // live MeloBot round-trip trying to discover extra albums. Users who want
  // live discography discovery can ask explicitly with "album / آلبوم".
  return albums;
}

function bulkTrackKey(track = {}) {
  return track.rawText || `${normalize(track.artist)}|${normalize(track.title)}`;
}

async function deliverNativeBulkHq(session, tracks, bulkResult, {
  label = 'bulk',
} = {}) {
  const sourceTracks = (tracks || []).slice();
  if (!sourceTracks.length) return { sent: 0, missing: 0, matched: 0 };

  const sourceMatches = matchBulkAudioToTracks(sourceTracks, bulkResult?.audioItems || []);
  const mediaByTrack = new Map();
  const canonicalBySourceKey = new Map();

  if (sourceMatches.length) {
    try {
      const bridged = await bridgeSourceMessages(
        config.melobotUsername,
        sourceMatches.map(item => item.audioItem.message),
        { timeoutMs: 6000 }
      );

      const bridgedMatches = matchBulkAudioToTracks(
        sourceMatches.map(item => item.track),
        bridged.items || []
      );

      for (const { track: sourceTrack, audioItem: media } of bridgedMatches) {
        const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
        const key = bulkTrackKey(track);
        mediaByTrack.set(key, media);

        const canonicalTrack = canonicalTrackFromAudioMetadata(track, media);
        if (!canonicalTrack.artistInferred) {
          canonicalBySourceKey.set(key, canonicalTrack);
        }

        if (canonicalTrack.artistInferred) {
          console.warn(
            `[${label} cache skipped]`,
            track.title,
            'primary artist is still inferred'
          );
          continue;
        }

        try {
          await Promise.all([
            cache.set(canonicalTrack, media, { sourceFetch: true }),
            deepCatalog.setMedia(
              canonicalTrack,
              'hq',
              media,
              { source: 'melobot', satisfiedBy: label }
            ),
          ]);
        } catch (err) {
          console.warn(
            `[${label} cache]`,
            canonicalTrack.artist,
            canonicalTrack.title,
            err.message
          );
        }
      }
    } catch (err) {
      console.warn(`[${label} batch bridge]`, err.message);
    }
  }

  const hqCache = await deepCatalog.getMediaMap(
    sourceTracks.filter(track => !track?.artistInferred),
    'hq'
  );

  let sent = 0;
  let missing = 0;
  const missingTracks = [];
  for (const sourceTrack of sourceTracks) {
    const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
    try {
      assertDeliveryAllowed(track, session.userRegion || 'unknown');
      const sourceKey = bulkTrackKey(track);
      const bridgedMedia = mediaByTrack.get(sourceKey);
      const canonicalTrack = canonicalBySourceKey.get(sourceKey) || track;
      const cachedHq = hqCache.get(deepTrackKey(canonicalTrack));
      const media = bridgedMedia || cachedHq;
      if (media) {
        await sendMedia(
          session.chatId,
          canonicalTrack,
          media,
          { cacheHit: !bridgedMedia && Boolean(cachedHq) }
        );
        sent += 1;
      } else {
        missing += 1;
        missingTracks.push(sourceTrack);
      }
    } catch (err) {
      console.warn(`[${label} deliver]`, track.artist, track.title, err.message);
      missing += 1;
      missingTracks.push(sourceTrack);
    }
  }

  return {
    sent,
    missing,
    missingTracks,
    canonicalTracks: sourceTracks.map(track =>
      canonicalBySourceKey.get(bulkTrackKey(track)) || track
    ),
    matched: sourceMatches.length,
    quality: 'hq',
  };
}

async function deliverBulkFromCacheIfComplete(session, tracks) {
  const sourceTracks = (tracks || []).slice();
  if (!sourceTracks.length) return { complete: false, sent: 0, quality: 'hq' };

  const canonicalTracks = sourceTracks.filter(track => !track?.artistInferred);
  const hqCache = await deepCatalog.getMediaMap(canonicalTracks, 'hq');
  const complete = sourceTracks.every(track =>
    !track?.artistInferred && hqCache.has(deepTrackKey(track))
  );
  if (!complete) return { complete: false, sent: 0, quality: 'hq' };

  let sent = 0;
  for (const sourceTrack of sourceTracks) {
    const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
    assertDeliveryAllowed(track, session.userRegion || 'unknown');
    await sendMedia(
      session.chatId,
      track,
      hqCache.get(deepTrackKey(track)),
      { cacheHit: true }
    );
    sent += 1;
  }

  console.log(`[fastpath] bulk_hq_cache=complete count=${sent}`);
  return { complete: true, sent, quality: 'hq' };
}

function structuralNativeBulkFailure(err) {
  return /bulk HQ button was not found|artist button not found|no usable .* tracks/i.test(
    err?.message || ''
  );
}

async function deliverBulkIndividuallyHq(session, tracks, {
  sourceTimeoutMs = 6000,
  totalBudgetMs = 25000,
  label = 'bulk individual',
} = {}) {
  const sourceTracks = (tracks || []).slice(0, TOP_TRACKS_LIMIT);
  const deadline = Date.now() + Math.max(5000, Number(totalBudgetMs || 25000));
  let sent = 0;
  let missing = 0;

  for (let index = 0; index < sourceTracks.length; index += 1) {
    if (hasPendingForegroundSourceWork() || Date.now() >= deadline) {
      missing += sourceTracks.length - index;
      console.warn(
        `[${label}] paused remaining=${sourceTracks.length - index} reason=`
        + (hasPendingForegroundSourceWork() ? 'foreground' : 'time_budget')
      );
      break;
    }

    const track = applyPolicyDefaults({
      ...sourceTracks[index],
      source: sourceTracks[index].source || 'melobot',
    });

    try {
      await sendTrackQuality(
        session.chatId,
        track,
        'hq',
        session.userRegion || 'unknown',
        { sourceTimeoutMs }
      );
      sent += 1;
    } catch (err) {
      console.warn(`[${label}]`, track.artist, track.title, err.message);
      missing += 1;
    }
  }

  return { sent, missing, quality: 'hq' };
}

function bulkFallbackMessage(kind, sent, missing) {
  if (!missing) return null;

  const label = kind === 'album'
    ? 'آلبوم'
    : kind === 'top'
      ? 'پربازدیدترین‌ها'
      : 'جدیدترین‌ها';

  if (sent > 0) {
    return `بخشی از ${label} دانلود شد؛ ${missing} آهنگ فعلاً دریافت نشد. دوباره امتحان کن.`;
  }

  return `دانلود یکجای ${label} فعلاً انجام نشد. دوباره امتحان کن.`;
}

async function deliverAvailableBulkCache(session, tracks) {
  const sourceTracks = (tracks || []).slice();
  const hqCache = await deepCatalog.getMediaMap(sourceTracks, 'hq');

  let sent = 0;
  let missing = 0;
  for (const sourceTrack of sourceTracks) {
    const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
    try {
      assertDeliveryAllowed(track, session.userRegion || 'unknown');
      const cachedHq = hqCache.get(deepTrackKey(track));
      if (!cachedHq) {
        missing += 1;
        continue;
      }
      await sendMedia(session.chatId, track, cachedHq, { cacheHit: true });
      sent += 1;
    } catch {
      missing += 1;
    }
  }

  return { sent, missing, quality: 'hq' };
}

export async function showResults(sessionId, session, messageId = session.messageId) {
  const prompt = session.resultsPrompt || (
    session.albumFirst && !(session.options || []).length
      ? 'یک آلبوم رو انتخاب کن:'
      : session.albumOptions?.length
        ? 'یک آهنگ یا آلبوم رو انتخاب کن:'
        : 'یک نسخه رو انتخاب کن:'
  );
  const title = session.resultsTitle || `نتیجه‌ها برای «${session.query}»`;
  await bot.editMessageText(session.chatId,messageId,`${title}\n${prompt}`,{
    reply_markup: resultsKeyboard(sessionId,session),
  });
}

async function setBrowseResults(sessionId, session, messageId, tracks, {
  title,
  backAction,
  backText = '🔙 برگشت',
} = {}) {
  const visible = (tracks || []).slice(0, 10);
  if (!visible.length) throw new Error('Browse source returned no tracks.');

  session.options = visible;
  session.albumOptions = [];
  session.query = title || 'موسیقی';
  session.resultsTitle = title || 'موسیقی';
  session.resultsPrompt = 'یک آهنگ رو انتخاب کن:';
  session.resultsBackAction = backAction || 'hmn';
  session.resultsBackText = backText;
  session.currentTrack = null;
  session.trackBack = null;
  session.busy = false;
  await showResults(sessionId, session, messageId);
}

export const sourceQueue = new SerialQueue(async job => {
  const runStartedAt = Date.now();
  const queueWaitMs = Math.max(0, runStartedAt - Number(job?._queueMeta?.queuedAt || runStartedAt));
  const session = job.sessionId ? await sessions.get(job.sessionId) : null;
  try {
    if (job.type === 'search') {
      const searchPhaseStartedAt = Date.now();
      let primaryMs = 0;
      let albumOptionsMs = 0;
      let searchCacheHit = false;
      try {
        const albumIntent = hasAlbumIntent(job.query);
        const cacheKey = userSearchCacheKey(job.query);
        const cachedOptions = albumIntent
          ? null
          : await catalog.getSearch(cacheKey, config.catalogSearchTtlMs);
        let options = cachedOptions || [];
        let sourceAlbumOptions = [];
        let primarySource = cachedOptions ? 'catalog' : 'none';
        let primaryProbe = cachedOptions ? 'cache' : 'not_run';
        let primaryCoverage = cachedOptions ? null : 0;
        searchCacheHit = Boolean(cachedOptions);

        if (!albumIntent && !cachedOptions) {
          const primaryStartedAt = Date.now();
          try {
            const primary = await searchPrimaryTyped(job.query);
            options = primary.tracks || [];
            sourceAlbumOptions = (primary.albums || []).filter(album =>
              album?.artist && album?.title
            );
            primarySource = primary.source || 'unknown';
            primaryProbe = primary.exactProbe || 'not_needed';
            primaryCoverage = Number(primary.relevanceCoverage || 0);

            for (const album of sourceAlbumOptions) {
              await syncAlbumIndex(album.artist, [album], { complete: false });
              if (Array.isArray(album.tracks) && album.tracks.length) {
                await syncAlbumTracks(album.artist, album, album.tracks);
              }
            }
          } catch (err) {
            console.warn('[typed search]', err.message);
            options = [];
            sourceAlbumOptions = [];
          } finally {
            primaryMs = Date.now() - primaryStartedAt;
          }
        }

        const albumOptionsStartedAt = Date.now();
        options = await deepCatalog.canonicalizeKnownTracks(options);
        options = keepFullCoverageTracksWhenAvailable(job.query, options);

        const indexedAlbumOptions = await searchAlbumOptions(job.query, options);
        const albumLimit = albumIntent ? 20 : 4;
        const albumOptions = mergeAlbumResults(
          albumLimit,
          sourceAlbumOptions,
          indexedAlbumOptions
        );
        albumOptionsMs = Date.now() - albumOptionsStartedAt;
        if (!options.length && !albumOptions.length) throw new Error('No results');

        const albumFirst = albumOptions.length > 0 && (albumIntent || !options.length);
        const sessionId = newSessionId();
        const fresh = {
          chatId: job.chatId, userId: job.userId, query: job.query,
          messageId: job.statusMessageId, options, albumOptions, albumFirst, artistContext: null,
          artistSeed: null, isFollowing: false, albums: null, albumsEmptyConfirmed: false,
          currentAlbum: null, currentAlbumView: null, albumsPage: 0, albumTrackPage: 0,
          currentTrack: null, trackBack: null, artistBack: 'rs', busy: false,
          expiresAt: Date.now() + SESSION_TTL_MS,
        };
        await sessions.set(sessionId,fresh);
        await showResults(sessionId,fresh);

        if (!albumIntent && !cachedOptions && options.length) {
          try { await catalog.recordSearch(cacheKey,options); } catch (err) {
            console.warn('[search catalog]', err.message);
          }
          await Promise.all(options.map(async track => {
            try {
              await deepCatalog.upsertTrack(track,{ discoveredFrom: 'user:search' });
            } catch (err) {
              console.warn('[deep search upsert]', track.artist, track.title, err.message);
            }
          }));
        }

        console.log(
          `[perf.search] query=${JSON.stringify(job.query)} cache_hit=${searchCacheHit} `
          + `source=${primarySource} exact_probe=${primaryProbe} relevance_coverage=${primaryCoverage ?? 'cache'} `
          + `tracks=${options.length} albums=${albumOptions.length} `
          + `primary_ms=${primaryMs} album_options_ms=${albumOptionsMs} `
          + `phase_total_ms=${Date.now() - searchPhaseStartedAt}`
        );
      } catch (err) {
        console.error('[search]',err.message);
        await bot.editMessageText(job.chatId,job.statusMessageId,'نتیجه‌ای پیدا نشد.');
      }
      return;
    }

    if (job.type.startsWith('home_') && !session) return;

    if (job.type === 'home_feed') {
      try {
        const feed = HOME_FEEDS[job.feedKey];
        if (!feed) throw new Error('Unknown home feed.');

        const cacheKey = `browse:${feed.command}`;
        let tracks = await catalog.getSearch(cacheKey, config.catalogSearchTtlMs);
        if (!tracks?.length) {
          const result = await discoverMeloBotFeed(tg, feed.command, {
            contentOrigin: feed.origin,
          });
          tracks = result.tracks || [];
          if (tracks.length) {
            try { await catalog.recordSearch(cacheKey, tracks); } catch {}
            await Promise.all(tracks.map(track =>
              deepCatalog.upsertTrack(track, {
                discoveredFrom: `user:browse:${feed.command}`,
                feed: feed.command,
              }).catch(() => null)
            ));
          }
        }

        await setBrowseResults(job.sessionId, session, job.messageId, tracks, {
          title: feed.title,
          backAction: feed.backAction,
          backText: '🔙 دسته‌بندی‌ها',
        });
      } catch (err) {
        console.error('[home feed]', err.message);
        session.busy = false;
        const feed = HOME_FEEDS[job.feedKey];
        const keyboard = feed?.backAction === 'htop'
          ? topMenuKeyboard(job.sessionId)
          : newestMenuKeyboard(job.sessionId);
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          'این بخش فعلاً در دسترس نیست. دوباره امتحان کن.',
          { reply_markup: keyboard }
        );
      }
      return;
    }

    if (job.type === 'home_playlist') {
      try {
        const playlist = curatedPlaylistByKey(job.playlistKey);
        if (!playlist) throw new Error('Unknown curated playlist.');

        const cacheKey = `browse:playlist:${playlist.key}`;
        let tracks = await catalog.getSearch(cacheKey, 6 * 60 * 60 * 1000);
        if (!tracks?.length) {
          const opened = await openMeloBotCuratedPlaylist(tg, playlist);
          tracks = opened.tracks || [];
          if (tracks.length) {
            try { await catalog.recordSearch(cacheKey, tracks); } catch {}
            await Promise.all(tracks.map(track =>
              deepCatalog.upsertTrack(track, {
                discoveredFrom: `user:playlist:${playlist.key}`,
              }).catch(() => null)
            ));
          }
        }

        await setBrowseResults(job.sessionId, session, job.messageId, tracks, {
          title: `🎧 ${playlist.label}`,
          backAction: 'hpl',
          backText: '🔙 پلی‌لیست‌ها',
        });
      } catch (err) {
        console.error('[home playlist]', err.message);
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          'این پلی‌لیست فعلاً در دسترس نیست.',
          { reply_markup: curatedPlaylistsKeyboard(job.sessionId) }
        );
      }
      return;
    }

    if (job.type === 'home_artist') {
      try {
        const artistRow = session.followedArtists?.[job.index];
        const artist = artistRow?.artist_name || artistRow?.artistName || artistRow?.artist;
        if (!artist) throw new Error('Followed artist is missing.');

        const cachedArtist = await catalog.getArtistContext(artist, config.catalogArtistTtlMs);
        session.artistContext = cachedArtist && isUsableArtistContext(cachedArtist)
          ? cachedArtist
          : await openMeloBotArtistFastFresh(tg, artist, null);

        if (!isUsableArtistContext(session.artistContext)) {
          throw new Error('MeloBot returned an empty followed-artist context.');
        }

        session.artistSeed = session.artistContext.seedTrack || (
          session.artistContext.recentTracks?.[0] ||
          session.artistContext.topTracks?.[0] ||
          session.artistContext.tracks?.[0] ||
          null
        );
        await syncArtistContext(session.artistContext);
        try { await deepCatalog.clearCapabilityFailure(seed, 'hasArtistPage'); } catch {}
        session.isFollowing = await follows.isFollowing(session.userId, session.artistContext.artist);
        session.artistBack = 'hfol';
        session.albums = null;
        session.albumsEmptyConfirmed = false;
        session.busy = false;

        await bot.editMessageText(
          session.chatId,
          job.messageId,
          session.artistContext.artist,
          {
            reply_markup: artistHomeKeyboard(
              job.sessionId,
              session.artistContext,
              session.isFollowing,
              { backAction: 'hfol' }
            ),
          }
        );
      } catch (err) {
        console.error('[home artist]', err.message);
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          'باز کردن این خواننده ممکن نشد.',
          { reply_markup: followedArtistsKeyboard(job.sessionId, session.followedArtists || []) }
        );
      }
      return;
    }

    if (job.type === 'deep_crawl') {
      try {
        // Background navigation gets a short grace window. If a user request
        // arrived just after the crawler was claimed, give the stateful
        // MeloBot lane back before starting the crawl instead of making that
        // foreground request wait several seconds.
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (hasPendingForegroundSourceWork()) {
          await deepCatalog.deferTask(
            job.task?.id,
            60_000,
            'foreground request arrived during crawler grace window'
          );
          console.log('[deep crawler] deferred_for_foreground', job.task?.kind || 'unknown');
          return;
        }
        await executeDeepTask(job.task);
      } catch (err) {
        console.warn('[deep crawl job]', err.message);
      }
      return;
    }

    if (!session && !['discover','discover_bootstrap'].includes(job.type)) return;
    if (session) session.expiresAt = Date.now() + BUSY_SESSION_TTL_MS;

    if (job.type === 'search_album') {
      try {
        const album = session.albumOptions?.[job.index];
        if (!album?.artist || !album?.title) throw new Error('Search album is missing.');

        let tracks = album.albumKey
          ? await deepCatalog.getAlbumTracksByKey(album.albumKey)
          : [];
        if (!tracks.length) {
          tracks = await catalog.getAlbumTracks(
            album.artist,
            album.title,
            config.catalogAlbumTracksTtlMs
          ) || [];
        }

        let liveAlbum = album;
        let resolvedArtistName = album.artist;
        if (!tracks.length) {
          const seed = session.options?.find(track =>
            track.source === 'melobot' &&
            normalize(track.artist) === normalize(album.artist)
          ) || null;

          const directStartedAt = Date.now();
          const opened = await openMeloBotAlbumRobustByTitle(
            tg,
            album.artist,
            album.title,
            {
              album,
              timeoutMs: 4500,
              maxPages: 12,
            }
          );

          liveAlbum = {
            ...opened.album,
            bulkHighButton: opened.bulkHighButton || null,
            bulkNormalButton: opened.bulkNormalButton || null,
            sourceStateVersion: opened.sourceStateVersion ?? getMeloBotStateVersion(),
          };
          tracks = opened.tracks;
          resolvedArtistName = opened.artist || album.artist;
          session.artistSeed = opened.seed || session.artistSeed || seed || null;

          await Promise.all([
            syncAlbumIndex(resolvedArtistName, [{
              ...liveAlbum,
              artist: resolvedArtistName,
            }], { complete: false }),
            syncAlbumTracks(resolvedArtistName, liveAlbum, tracks),
          ]);

          console.log(
            `[fastpath] search_album=${opened.route || 'robust'} open_ms=${Date.now() - directStartedAt}`
          );
        }

        session.currentAlbum = {
          ...album,
          ...liveAlbum,
          artist: resolvedArtistName,
          tracks,
        };
        session.currentAlbumView = 'search';
        session.albumTrackPage = 0;
        session.busy = false;

        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `💿 ${album.title}\n${album.artist}`,
          {
            reply_markup: albumTracksKeyboard(
              job.sessionId,
              tracks,
              0,
              0,
              { backAction: 'results' }
            ),
          }
        );
      } catch (err) {
        console.error('[search album]', err.message);
        session.busy = false;
        await showResults(job.sessionId, session, job.messageId);
      }
      return;
    }

    if (job.type === 'track_page') {
      try {
        await renderTrackPage(job.sessionId, session, job.messageId);
      } catch (err) {
        console.error('[track page]', err.message);
        await bot.editMessageText(session.chatId, job.messageId, 'باز کردن صفحه‌ی آهنگ ممکن نشد.');
      }
      session.busy = false;
      return;
    }

    if (job.type === 'track_quality') {
      try {
        session.currentTrack = await resolveTrackIdentity(session.currentTrack);
        await sendTrackQuality(
          session.chatId,
          session.currentTrack,
          job.quality,
          session.userRegion || 'unknown',
          { sourceTimeoutMs: 6500 }
        );
      } catch (err) {
        console.error('[track quality]', err.message);
        const text = err.code === 'REGION_RESTRICTED_IRAN_ONLY'
          ? 'این محتوا فقط برای کاربران داخل ایران در دسترسه.'
          : 'این کیفیت فعلاً در دسترس نیست.';
        await bot.sendMessage(session.chatId, text);
      }
      session.busy = false;
      try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      return;
    }

    if (job.type === 'track_lyrics') {
      try {
        session.currentTrack = await resolveTrackIdentity(session.currentTrack);
        await sendTrackLyrics(session.chatId, session.currentTrack);
      } catch (err) {
        console.error('[track lyrics]', err.message);
        await bot.sendMessage(session.chatId, 'متن این آهنگ فعلاً در دسترس نیست.');
      }
      session.busy = false;
      try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      return;
    }

    if (job.type === 'track_cover') {
      try {
        session.currentTrack = await resolveTrackIdentity(session.currentTrack);
        await sendTrackCover(session.chatId, session.currentTrack);
      } catch (err) {
        console.error('[track cover]', err.message);
        await bot.sendMessage(session.chatId, 'کاور این آهنگ فعلاً در دسترس نیست.');
      }
      session.busy = false;
      try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      return;
    }

    if (job.type === 'track_info') {
      try {
        session.currentTrack = await resolveTrackIdentity(session.currentTrack);
        const text = await getTrackInfoText(session.currentTrack);
        await bot.sendMessage(session.chatId, text);
      } catch (err) {
        console.error('[track info]', err.message);
        await bot.sendMessage(session.chatId, 'مشخصات بیشتری برای این آهنگ پیدا نشد.');
      }
      session.busy = false;
      try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      return;
    }

    if (job.type === 'artist_list') {
      const startedAt = Date.now();
      const mode = job.mode === 'recent' ? 'recent' : 'top';
      const label = mode === 'recent' ? 'جدیدترین آثار' : 'پربازدیدترین آثار';
      let route = 'unknown';

      try {
        const artist = session.artistContext?.artist;
        if (!artist) throw new Error('Artist context missing for list.');

        let tracks = mode === 'recent'
          ? (session.artistContext.recentTracks || [])
          : (session.artistContext.topTracks || []);

        if (tracks.length) {
          route = 'session';
        } else {
          const indexed = await deepCatalog.getArtistList(
            artist,
            mode,
            TOP_TRACKS_LIMIT
          ).catch(() => []);

          if (indexed.length) {
            tracks = indexed;
            route = 'deep_catalog';
          } else {
            const derived = await deepCatalog.deriveArtistList(
              artist,
              mode,
              TOP_TRACKS_LIMIT
            ).catch(() => []);

            if (derived.length) {
              tracks = derived;
              route = `derived_${mode}`;
            } else {
              const resolved = await resolveMeloBotArtistTrackList(
                tg,
                artist,
                mode,
                session.artistSeed || null
              );
              tracks = resolved.tracks || [];
              route = resolved.route || 'live';
              session.artistSeed = resolved.seed || session.artistSeed || null;

              if (mode === 'recent') {
                session.artistContext = {
                  ...session.artistContext,
                  artist: resolved.artist || artist,
                  recentTracks: tracks,
                  recentBulkHighButton:
                    resolved.context?.recentBulkHighButton
                    || session.artistContext.recentBulkHighButton
                    || null,
                  recentBulkNormalButton:
                    resolved.context?.recentBulkNormalButton
                    || session.artistContext.recentBulkNormalButton
                    || null,
                };
              } else {
                session.artistContext = {
                  ...session.artistContext,
                  ...(resolved.context || {}),
                  artist: resolved.artist || artist,
                  topTracks: tracks,
                  tracks,
                  recentTracks:
                    session.artistContext.recentTracks?.length
                      ? session.artistContext.recentTracks
                      : (resolved.context?.recentTracks || []),
                };
              }
            }
          }

          if (mode === 'recent') {
            session.artistContext = {
              ...session.artistContext,
              recentTracks: tracks,
            };
          } else {
            session.artistContext = {
              ...session.artistContext,
              topTracks: tracks,
              tracks,
            };
          }

          await syncArtistContext(session.artistContext);
        }

        if (!tracks.length) throw new Error(`No ${mode} artist tracks available.`);

        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `${session.artistContext.artist}\n${mode === 'recent' ? '🆕' : '🎵'} ${label}`,
          {
            reply_markup: artistSongsKeyboard(
              job.sessionId,
              tracks,
              { mode }
            ),
          }
        );

        console.log(
          `[perf.artist_list] artist=${JSON.stringify(session.artistContext.artist)} `
          + `mode=${mode} route=${route} count=${tracks.length} `
          + `total_ms=${Date.now() - startedAt}`
        );
      } catch (err) {
        console.error('[artist list]', mode, err.message);
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `${session.artistContext?.artist || 'خواننده'}\n\n${label} فعلاً قابل دریافت نیست.`,
          {
            reply_markup: artistHomeKeyboard(
              job.sessionId,
              session.artistContext || {},
              session.isFollowing,
              { backAction: session.artistBack || 'rs' }
            ),
          }
        );
        console.log(
          `[perf.artist_list] mode=${mode} route=${route} `
          + `total_ms=${Date.now() - startedAt} error=true`
        );
      }
      return;
    }

    if (job.type === 'track_artist') {
      const artistStartedAt = Date.now();
      let artistRoute = 'unknown';
      try {
        session.currentTrack = await resolveTrackIdentity(session.currentTrack);
        const seed = session.currentTrack;
        if (!seed?.artist) throw new Error('Track artist is missing.');
        if (seed.artistInferred) {
          throw new Error('Track primary artist could not be confirmed.');
        }

        const cachedArtist = await catalog.getArtistContext(
          seed.artist,
          config.catalogArtistTtlMs
        );

        if (cachedArtist && isUsableArtistContext(cachedArtist)) {
          session.artistContext = cachedArtist;
          artistRoute = cachedArtist.healedLegacyLists ? 'catalog_healed' : 'catalog';
        } else {
          const [storedTop, storedRecent] = await Promise.all([
            deepCatalog.getArtistList(seed.artist, 'top', TOP_TRACKS_LIMIT),
            deepCatalog.getArtistList(seed.artist, 'recent', TOP_TRACKS_LIMIT),
          ]);
          const derivedTop = storedTop.length
            ? storedTop
            : await deepCatalog.deriveArtistList(seed.artist, 'top', TOP_TRACKS_LIMIT);
          const deepContext = {
            artist: seed.artist,
            tracks: derivedTop.length ? derivedTop : storedRecent,
            topTracks: derivedTop,
            recentTracks: storedRecent,
            fromDeepCatalog: true,
          };

          if (isUsableArtistContext(deepContext)) {
            session.artistContext = deepContext;
            artistRoute = storedTop.length || storedRecent.length
              ? 'deep_catalog'
              : 'deep_derived';
          } else {
            session.artistContext = await openMeloBotArtistFastFresh(
              tg,
              seed.artist,
              seed.source === 'melobot' ? seed : null
            );
            artistRoute = session.artistContext.recoveredFromAlbum
              ? 'live_album_recovery'
              : 'live';
          }
        }

        if (!isUsableArtistContext(session.artistContext)) {
          throw new Error('MeloBot returned an empty artist context.');
        }

        session.artistSeed = session.artistContext.seedTrack
          || (seed.source === 'melobot'
            ? seed
            : (session.artistContext.recentTracks?.[0] || session.artistContext.topTracks?.[0] || null));

        await syncArtistContext(session.artistContext);
        session.isFollowing = await follows.isFollowing(session.userId, session.artistContext.artist);
        session.artistBack = 'trt';
        session.albums = null;
        session.albumsEmptyConfirmed = false;
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          session.artistContext.artist,
          {
            reply_markup: artistHomeKeyboard(
              job.sessionId,
              session.artistContext,
              session.isFollowing,
              { backAction: 'trt' }
            ),
          }
        );

        console.log(
          `[perf.track_artist] artist=${JSON.stringify(session.artistContext.artist)} `
          + `route=${artistRoute} tracks=${artistContextTracks(session.artistContext).length} `
          + `total_ms=${Date.now() - artistStartedAt}`
        );
      } catch (err) {
        console.error('[track artist]', err.message);
        try {
          if (session.currentTrack) {
            await deepCatalog.markCapabilityFailure(
              session.currentTrack,
              'hasArtistPage',
              err.message
            );
          }
        } catch {}
        console.log(
          `[perf.track_artist] route=${artistRoute} total_ms=${Date.now() - artistStartedAt} error=true`
        );
        session.busy = false;
        try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      }
      return;
    }

    if (job.type === 'track_album') {
      try {
        const albumData = await getTrackAlbum(session.currentTrack);
        if (!albumData?.album || !albumData.tracks?.length) {
          throw new Error('Track album is not available.');
        }
        session.albumOriginTrack = session.currentTrack;
        session.albumOriginBack = session.trackBack;
        session.currentAlbum = { ...albumData.album, tracks: albumData.tracks };
        session.currentAlbumView = 'track';
        session.albumTrackPage = 0;
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `💿 ${albumData.album.title}\n${albumData.album.artist || session.currentTrack.artist}`,
          { reply_markup: trackAlbumKeyboard(job.sessionId, albumData.album, albumData.tracks, 0) }
        );
      } catch (err) {
        console.error('[track album]', err.message);
        session.busy = false;
        try { await renderTrackPage(job.sessionId, session, job.messageId); } catch {}
      }
      return;
    }

    if (job.type === 'download_recent') {
      const requestedTracks = session.artistContext?.recentTracks?.slice(0, TOP_TRACKS_LIMIT) || [];
      let sent = 0;
      let missing = 0;
      let fallbackNotified = false;

      try {
        const cached = await deliverBulkFromCacheIfComplete(session, requestedTracks);
        if (cached.complete) {
          sent = cached.sent;
        } else {
          const seed = session.artistSeed || session.options.find(x =>
            x.source === 'melobot' &&
            normalize(x.artist) === normalize(session.artistContext.artist)
          );
          if (!seed) throw new Error('Artist seed missing for newest bulk HQ.');

          let liveArtist;
          let bulk;
          let lastError;
          for (let attempt = 0; attempt < 1; attempt += 1) {
            try {
              liveArtist = await prepareMeloBotBulkRecentTracks(
                tg,
                session.artistContext.artist,
                seed,
                { timeoutMs: 3500 }
              );
              bulk = await downloadMeloBotRecentTracks(
                tg,
                liveArtist,
                { timeoutMs: 6500 }
              );
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk recent retry]', attempt + 1, err.message);
              if (
                attempt === 0
                && (structuralNativeBulkFailure(err) || hasPendingForegroundSourceWork())
              ) {
                console.warn(
                  '[bulk guard] recent retry skipped:',
                  structuralNativeBulkFailure(err) ? 'structural source failure' : 'foreground work is waiting'
                );
                break;
              }
            }
          }
          if (lastError || !liveArtist || !bulk) throw lastError || new Error('Newest native bulk failed.');

          session.artistContext = {
            ...session.artistContext,
            ...liveArtist,
            tracks: session.artistContext.topTracks || session.artistContext.tracks || [],
          };
          await syncArtistContext({
            ...session.artistContext,
            artist: liveArtist.artist,
            recentTracks: liveArtist.recentTracks || [],
            albumButton: liveArtist.albumButton || session.artistContext.albumButton || null,
          });

          const liveTracks = (liveArtist.recentTracks || requestedTracks).slice(0, TOP_TRACKS_LIMIT);
          const delivered = await deliverNativeBulkHq(session, liveTracks, bulk, {
            label: 'native bulk recent',
          });
          sent = delivered.sent;
          missing = delivered.missing;
          if (delivered.canonicalTracks?.length) {
            session.artistContext.recentTracks = delivered.canonicalTracks;
            await syncArtistContext(session.artistContext);
          }

        }
      } catch (err) {
        console.warn('[native bulk recent failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        const fallbackMessage = bulkFallbackMessage('recent', sent, missing);
        if (fallbackMessage) {
          await bot.sendMessage(session.chatId, fallbackMessage);
          fallbackNotified = true;
        }
      }

      if (!fallbackNotified && missing > 0 && sent > 0) {
        const notice = bulkFallbackMessage('recent', sent, missing);
        if (notice) await bot.sendMessage(session.chatId, notice);
      }
      session.busy = false;
      await bot.editMessageText(
        session.chatId,
        job.messageId,
        `${session.artistContext.artist}\n🆕 جدیدترین آثار`,
        {
          reply_markup: artistSongsKeyboard(
            job.sessionId,
            session.artistContext.recentTracks || requestedTracks,
            { mode: 'recent' }
          ),
        }
      );
      console.log(`[native bulk recent] sent=${sent}, missing=${missing}`);
      return;
    }

    if (job.type === 'download') {
      const track = applyPolicyDefaults(job.track);
      try {
        assertDeliveryAllowed(track,session.userRegion || 'unknown');
        const outcome = await downloadTrackWithSources(track,session.query);
        if (outcome.cached) await deliverCached(session.chatId,outcome.track,outcome.cached);
        else await sendMedia(session.chatId,outcome.track,outcome.media);
        try { await bot.deleteMessage(session.chatId,job.messageId); } catch {}
        session._deleted = true;
        await sessions.delete(job.sessionId);
      } catch (err) {
        console.error('[download]',err.message);
        session.busy = false;
        const text = err.code === 'REGION_RESTRICTED_IRAN_ONLY'
          ? 'این محتوا فقط برای کاربران داخل ایران در دسترسه.'
          : 'این نسخه در دسترس نیست.';
        await bot.editMessageText(session.chatId,job.messageId,text,{
          reply_markup: resultsKeyboard(job.sessionId,session),
        });
      }
      return;
    }

    if (job.type === 'download_top') {
      const requestedTracks = (
        session.artistContext?.topTracks || []
      ).slice(0, TOP_TRACKS_LIMIT);
      let sent = 0;
      let missing = 0;
      let fallbackNotified = false;

      try {
        const cached = await deliverBulkFromCacheIfComplete(session, requestedTracks);
        if (cached.complete) {
          sent = cached.sent;
        } else {
          const seed = session.artistSeed || session.options.find(x =>
            x.source === 'melobot' &&
            normalize(x.artist) === normalize(session.artistContext.artist)
          );
          if (!seed) throw new Error('Artist seed missing for top bulk HQ.');

          let liveArtist;
          let bulk;
          let lastError;
          for (let attempt = 0; attempt < 1; attempt += 1) {
            try {
              liveArtist = await prepareMeloBotBulkTopTracks(
                tg,
                session.artistContext.artist,
                seed,
                { timeoutMs: 3500 }
              );
              bulk = await downloadMeloBotTopTracks(
                tg,
                liveArtist,
                { timeoutMs: 6500 }
              );
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk top retry]', attempt + 1, err.message);
              if (
                attempt === 0
                && (structuralNativeBulkFailure(err) || hasPendingForegroundSourceWork())
              ) {
                console.warn(
                  '[bulk guard] top retry skipped:',
                  structuralNativeBulkFailure(err) ? 'structural source failure' : 'foreground work is waiting'
                );
                break;
              }
            }
          }
          if (lastError || !liveArtist || !bulk) throw lastError || new Error('Top native bulk failed.');

          session.artistContext = { ...session.artistContext, ...liveArtist };
          await syncArtistContext(liveArtist);

          const liveTracks = (liveArtist.topTracks || liveArtist.tracks || requestedTracks)
            .slice(0, TOP_TRACKS_LIMIT);
          const delivered = await deliverNativeBulkHq(session, liveTracks, bulk, {
            label: 'native bulk top',
          });
          sent = delivered.sent;
          missing = delivered.missing;
          if (delivered.canonicalTracks?.length) {
            session.artistContext.topTracks = delivered.canonicalTracks;
            session.artistContext.tracks = delivered.canonicalTracks;
            await syncArtistContext(session.artistContext);
          }

        }
      } catch (err) {
        console.warn('[native bulk top failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        const fallbackMessage = bulkFallbackMessage('top', sent, missing);
        if (fallbackMessage) {
          await bot.sendMessage(session.chatId, fallbackMessage);
          fallbackNotified = true;
        }
      }

      if (!fallbackNotified && missing > 0 && sent > 0) {
        const notice = bulkFallbackMessage('top', sent, missing);
        if (notice) await bot.sendMessage(session.chatId, notice);
      }
      session.busy = false;
      const tracks = session.artistContext?.topTracks || requestedTracks;
      await bot.editMessageText(
        session.chatId,
        job.messageId,
        `${session.artistContext.artist}\n🎵 پربازدیدترین آثار`,
        {
          reply_markup: artistSongsKeyboard(job.sessionId, tracks, { mode: 'top' }),
        }
      );
      console.log(`[native bulk top] sent=${sent}, missing=${missing}`);
      return;
    }

    if (job.type === 'download_album') {
      const requestedTracks = session.currentAlbum?.tracks || [];
      let sent = 0;
      let missing = 0;
      let fallbackNotified = false;

      try {
        const cached = await deliverBulkFromCacheIfComplete(session, requestedTracks);
        if (cached.complete) {
          sent = cached.sent;
        } else {
          const artist = session.currentAlbum?.artist
            || session.artistContext?.artist
            || session.albumOriginTrack?.artist
            || session.currentTrack?.artist;
          const albumTitle = session.currentAlbum?.title;
          if (!artist || !albumTitle) {
            throw new Error('Album identity missing for native bulk HQ.');
          }

          let albumContext;
          let bulk;
          let lastError;
          for (let attempt = 0; attempt < 1; attempt += 1) {
            try {
              const preferredSeed = session.artistSeed
                || session.albumOriginTrack
                || session.currentTrack
                || null;

              const canUseLiveAlbumPage = Boolean(
                attempt === 0
                && session.currentAlbum?.bulkHighButton
                && Number(session.currentAlbum?.sourceStateVersion || -1) === getMeloBotStateVersion()
              );

              if (canUseLiveAlbumPage) {
                albumContext = {
                  artist,
                  album: session.currentAlbum,
                  tracks: session.currentAlbum.tracks || requestedTracks,
                  bulkHighButton: session.currentAlbum.bulkHighButton,
                  bulkNormalButton: session.currentAlbum.bulkNormalButton || null,
                  sourceStateVersion: session.currentAlbum.sourceStateVersion,
                };
                console.log('[fastpath] album_bulk=current_album_page');
              } else {
                albumContext = await openMeloBotAlbumRobustByTitle(
                  tg,
                  artist,
                  albumTitle,
                  {
                    album: session.currentAlbum,
                    timeoutMs: 4500,
                    maxPages: 8,
                  }
                );
                session.artistSeed = albumContext.seed || session.artistSeed || preferredSeed;
              }

              if (!albumContext.bulkHighButton) {
                throw new Error('MeloBot bulk HQ button was not found on the album page.');
              }

              bulk = await downloadMeloBotAlbumTracks(
                tg,
                albumContext,
                { timeoutMs: 6500 }
              );
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk album retry]', attempt + 1, err.message);
              if (
                attempt === 0
                && (structuralNativeBulkFailure(err) || hasPendingForegroundSourceWork())
              ) {
                console.warn(
                  '[bulk guard] album retry skipped:',
                  structuralNativeBulkFailure(err) ? 'structural source failure' : 'foreground work is waiting'
                );
                break;
              }
            }
          }
          if (lastError || !albumContext || !bulk) throw lastError || new Error('Album native bulk failed.');

          session.currentAlbum = {
            ...session.currentAlbum,
            ...albumContext.album,
            artist: albumContext.artist,
            tracks: albumContext.tracks,
            bulkHighButton: albumContext.bulkHighButton || null,
            bulkNormalButton: albumContext.bulkNormalButton || null,
            sourceStateVersion: albumContext.sourceStateVersion ?? getMeloBotStateVersion(),
          };

          await syncAlbumTracks(
            albumContext.artist,
            albumContext.album,
            albumContext.tracks
          );

          const delivered = await deliverNativeBulkHq(
            session,
            albumContext.tracks,
            bulk,
            { label: 'native bulk album' }
          );
          sent = delivered.sent;
          missing = delivered.missing;
          if (delivered.canonicalTracks?.length) {
            session.currentAlbum.tracks = delivered.canonicalTracks;
            await syncAlbumTracks(
              session.currentAlbum.artist || albumContext.artist,
              session.currentAlbum,
              delivered.canonicalTracks
            );
          }

        }
      } catch (err) {
        console.warn('[native bulk album failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        const fallbackMessage = bulkFallbackMessage('album', sent, missing);
        if (fallbackMessage) {
          await bot.sendMessage(session.chatId, fallbackMessage);
          fallbackNotified = true;
        }
      }

      if (!fallbackNotified && missing > 0 && sent > 0) {
        const notice = bulkFallbackMessage('album', sent, missing);
        if (notice) await bot.sendMessage(session.chatId, notice);
      }
      session.busy = false;
      const album = session.currentAlbum;
      const title = `💿 ${album?.title || 'آلبوم'}\n${album?.artist || session.artistContext?.artist || ''}`;
      const keyboard = session.currentAlbumView === 'track'
        ? trackAlbumKeyboard(job.sessionId, album, album?.tracks || [], session.albumTrackPage || 0)
        : albumTracksKeyboard(
            job.sessionId,
            album?.tracks || [],
            session.albumsPage || 0,
            session.albumTrackPage || 0,
            { backAction: session.currentAlbumView === 'search' ? 'results' : 'albums' }
          );

      await bot.editMessageText(
        session.chatId,
        job.messageId,
        title,
        { reply_markup: keyboard }
      );
      console.log(`[native bulk album] sent=${sent}, missing=${missing}`);
      return;
    }

    if (job.type === 'discover') {
      const candidate = job.candidate;
      if (!candidate?.artist) return;
      const runId = await recordCrawlerStart(candidate.artist);
      try {
        const liveArtist = await openMeloBotArtistFresh(
          tg,
          candidate.artist,
          candidate.seedTrack
            ? { ...candidate.seedTrack, source: 'melobot' }
            : null,
          { timeoutMs: 7000 }
        );

        await syncArtistContext(liveArtist);

        for (const relatedArtist of liveArtist.relatedArtists || []) {
          if (normalize(relatedArtist) !== normalize(liveArtist.artist)) {
            await catalog.ensureArtist(relatedArtist,{
              discoveredFrom: `artist-picker:${liveArtist.artist}`,
            });
          }
        }

        let supplemental = 0;
        if (config.discoveryUseAhangify && !hasPendingForegroundSourceWork()) {
          try {
            const extra = await searchAhangify(
              tg,
              liveArtist.artist,
              { timeoutMs: 5000 }
            );
            const targetArtist = normalize(liveArtist.artist);
            const tracks = extra
              .map(item => sourceCandidateToTrack({ ...item, source: 'ahangify' }))
              .filter(track => {
                const candidateArtist = normalize(track.artist || '');
                if (!candidateArtist) return false;
                if (candidateArtist === targetArtist) return true;
                return candidateArtist
                  .split(/\s*(?:&|,|\bx\b)\s*/iu)
                  .some(part => normalize(part) === targetArtist);
              });
            if (tracks.length) {
              await catalog.recordSupplementalTracks(
                liveArtist.artist,
                tracks,
                'crawl:ahangify'
              );
              supplemental = tracks.length;
            }
          } catch (err) {
            console.warn('[crawler ahangify]', liveArtist.artist, err.message);
          }
        }

        let albums = [];
        if (!hasPendingForegroundSourceWork()) {
          try {
            albums = await listMeloBotAlbums(
              tg,
              liveArtist,
              { timeoutMs: 5000 }
            );
            await catalog.recordAlbums(liveArtist.artist, albums);

            if (albums.length) {
              const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
              await deepCatalog.enqueueTask(
                'album_index',
                {
                  artist: liveArtist.artist,
                  seedTrack: candidate.seedTrack || liveArtist.seedTrack || null,
                },
                {
                  priority: 72,
                  taskKey: `album_index:${normalize(liveArtist.artist)}:${day}`,
                }
              );
            }
          } catch (err) {
            console.warn('[crawler albums]', liveArtist.artist, err.message);
          }
        }

        // Album-detail crawling and media warming used to run inline here and
        // could hold the single interactive source lane after an idle period.
        // Those operations now belong exclusively to low-priority deep tasks.
        await catalog.markDiscoveryChecked(liveArtist.artist,{ ok: true });

        const summary = {
          top: (liveArtist.topTracks || []).length,
          recent: (liveArtist.recentTracks || []).length,
          albums: albums.length,
          supplemental,
          yielded: hasPendingForegroundSourceWork(),
        };
        await recordCrawlerFinish(runId,{ ok: true, summary });
        console.log(
          `[crawler] ${liveArtist.artist}: top=${summary.top}, recent=${summary.recent}, albums=${summary.albums}, yielded=${summary.yielded}`
        );
      } catch (err) {
        console.warn('[crawler]',candidate.artist,err.message);
        await catalog.markDiscoveryChecked(candidate.artist,{
          ok: false,
          error: err.message,
          nextDelayMs: config.discoveryRetryDelayMs,
        });
        await recordCrawlerFinish(runId,{ ok: false, error: err.message });
      }
      return;
    }

    if (job.type === 'discover_bootstrap') {
      const runId = await recordCrawlerStart('bootstrap');
      try {
        const discovered = await discoverMeloBotHome(tg);
        if (discovered.tracks?.length) {
          await catalog.recordSearch('__melobot_home__',discovered.tracks.map(track => ({ ...track, source: 'melobot' })));
        }
        for (const artist of discovered.artists || []) await catalog.ensureArtist(artist,{ discoveredFrom: 'crawl:melobot-home' });
        await setState('last_bootstrap_v2_at',{ at: Date.now() });
        const bootstrapSummary = {
          tracks: discovered.tracks?.length || 0,
          artists: discovered.artists?.length || 0,
          sections: discovered.sections?.length || 0,
        };
        await recordCrawlerFinish(runId,{ ok: true, summary: bootstrapSummary });
        console.log(`[crawler bootstrap] sections=${bootstrapSummary.sections}, tracks=${bootstrapSummary.tracks}, artists=${bootstrapSummary.artists}`);
      } catch (err) {
        await recordCrawlerFinish(runId,{ ok: false, error: err.message });
        console.warn('[crawler bootstrap]',err.message);
      }
      return;
    }

    if (job.type === 'artist_from_album') {
      const artistStartedAt = Date.now();
      let artistRoute = 'unknown';
      try {
        const album = session.albumOptions?.[job.albumIndex];
        const artist = album?.artist;
        if (!artist) throw new Error('Album artist is missing.');

        const cachedArtist = await catalog.getArtistContext(
          artist,
          config.catalogArtistTtlMs
        );

        if (cachedArtist && isUsableArtistContext(cachedArtist)) {
          session.artistContext = cachedArtist;
          artistRoute = 'catalog';
        } else {
          const albumSeed = (album.tracks || []).find(track =>
            track?.rawText && normalize(track.artist) === normalize(artist)
          ) || null;

          session.artistContext = albumSeed
            ? await openMeloBotArtistFast(tg, { ...albumSeed, source: 'melobot' })
            : await openMeloBotArtistFastFresh(tg, artist, null);
          artistRoute = albumSeed
            ? (session.artistContext.recoveredFromAlbum ? 'album_live_recovery' : 'album_track_seed')
            : 'fresh_artist_search';
        }

        if (!isUsableArtistContext(session.artistContext)) {
          throw new Error('MeloBot returned an empty album-derived artist context.');
        }

        session.artistSeed = session.artistContext.seedTrack
          || session.artistContext.recentTracks?.[0]
          || session.artistContext.topTracks?.[0]
          || session.artistContext.tracks?.[0]
          || null;

        await syncArtistContext(session.artistContext);
        session.isFollowing = await follows.isFollowing(
          session.userId,
          session.artistContext.artist
        );
        session.artistBack = 'rs';
        session.albums = null;
        session.albumsEmptyConfirmed = false;
        session.busy = false;

        await bot.editMessageText(
          session.chatId,
          job.messageId,
          session.artistContext.artist,
          {
            reply_markup: artistHomeKeyboard(
              job.sessionId,
              session.artistContext,
              session.isFollowing,
              { backAction: 'rs' }
            ),
          }
        );

        console.log(
          `[perf.artist_from_album] artist=${JSON.stringify(session.artistContext.artist)} `
          + `route=${artistRoute} tracks=${artistContextTracks(session.artistContext).length} `
          + `total_ms=${Date.now() - artistStartedAt}`
        );
      } catch (err) {
        console.error('[artist from album]', err.message);
        console.log(
          `[perf.artist_from_album] route=${artistRoute} `
          + `total_ms=${Date.now() - artistStartedAt} error=true`
        );
        session.busy = false;
        await showResults(job.sessionId, session, job.messageId);
      }
      return;
    }

    if (job.type === 'artist') {
      const artistStartedAt = Date.now();
      let artistRoute = 'unknown';
      let cacheMs = 0;
      let sourceMs = 0;
      let sourceStartedAt = 0;
      try {
        const indexedSeed = Number.isInteger(job.seedIndex) && job.seedIndex >= 0
          ? session.options?.[job.seedIndex]
          : null;
        const seed = indexedSeed?.source === 'melobot'
          ? indexedSeed
          : session.options.find(x => x.source === 'melobot');
        if (!seed) throw new Error('Artist profile currently requires MeloBot result.');

        const cacheStartedAt = Date.now();
        const cachedArtist = await catalog.getArtistContext(
          seed.artist,
          config.catalogArtistTtlMs
        );
        cacheMs = Date.now() - cacheStartedAt;

        if (cachedArtist && isUsableArtistContext(cachedArtist)) {
          session.artistContext = cachedArtist;
          artistRoute = 'catalog';
        } else {
          sourceStartedAt = Date.now();
          session.artistContext = await openMeloBotArtistFast(tg, seed);
          sourceMs = Date.now() - sourceStartedAt;
          artistRoute = session.artistContext.recoveredFromAlbum
            ? 'live_album_recovery'
            : 'live';
        }

        if (!isUsableArtistContext(session.artistContext)) {
          throw new Error('MeloBot returned an empty artist context.');
        }

        session.artistSeed = session.artistContext.seedTrack || seed;
        await syncArtistContext(session.artistContext);

        if (!cachedArtist) {
          for (const relatedArtist of session.artistContext.relatedArtists || []) {
            if (normalize(relatedArtist) !== normalize(session.artistContext.artist)) {
              await catalog.ensureArtist(relatedArtist,{ discoveredFrom: `artist-picker:${session.artistContext.artist}` });
            }
          }
        }

        session.isFollowing = await follows.isFollowing(session.userId,session.artistContext.artist);
        session.artistBack = 'rs';
        session.albums = null; session.albumsEmptyConfirmed = false; session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(job.sessionId,session.artistContext,session.isFollowing,{ backAction: session.artistBack || 'rs' }),
        });

        console.log(
          `[perf.artist] artist=${JSON.stringify(session.artistContext.artist)} route=${artistRoute} `
          + `cache_ms=${cacheMs} source_ms=${sourceMs} tracks=${artistContextTracks(session.artistContext).length} `
          + `total_ms=${Date.now() - artistStartedAt}`
        );
      } catch (err) {
        if (sourceStartedAt && !sourceMs) sourceMs = Date.now() - sourceStartedAt;
        console.error('[artist]',err.message);
        console.log(
          `[perf.artist] artist=${JSON.stringify(session.artistContext?.artist || '')} `
          + `route=${artistRoute} cache_ms=${cacheMs} source_ms=${sourceMs} `
          + `total_ms=${Date.now() - artistStartedAt} error=true`
        );
        session.busy = false;
        await showResults(job.sessionId,session,job.messageId);
      }
      return;
    }

    if (job.type === 'albums') {
      const albumsStartedAt = Date.now();
      let albumsRoute = 'unknown';
      let cacheMs = 0;
      let sourceMs = 0;
      let sourceStartedAt = 0;

      try {
        if (!session.artistContext?.artist) throw new Error('Artist context missing');
        const artist = session.artistContext.artist;

        const trustedSessionAlbums = Array.isArray(session.albums) && (
          session.albums.length > 0 || session.albumsEmptyConfirmed === true
        );

        if (trustedSessionAlbums) {
          albumsRoute = 'session';
        } else {
          const cacheStartedAt = Date.now();
          const cachedAlbums = await catalog.getAlbums(
            artist,
            config.catalogAlbumsTtlMs,
            config.catalogEmptyAlbumsTtlMs
          );
          cacheMs = Date.now() - cacheStartedAt;

          if (Array.isArray(cachedAlbums)) {
            session.albums = cachedAlbums;
            session.albumsEmptyConfirmed = cachedAlbums.length === 0;
            albumsRoute = 'catalog';
          } else {
            const seed = session.artistSeed || session.options.find(x =>
              x.source === 'melobot' && normalize(x.artist) === normalize(artist)
            ) || null;

            sourceStartedAt = Date.now();
            let resolved = null;

            const canUseLiveArtistSurface = Boolean(
              Number(session.artistContext?.liveAlbumSourceStateVersion || -1)
                === getMeloBotStateVersion()
              && (
                session.artistContext?.liveAlbumListingConfirmed
                || session.artistContext?.liveAlbumButton
              )
            );

            if (canUseLiveArtistSurface) {
              try {
                resolved = await resolveMeloBotAlbumsFromLiveArtistContext(
                  tg,
                  session.artistContext,
                  { allowEmpty: true, maxAlbums: 60 }
                );
                albumsRoute = resolved.source || 'live_artist_surface';
                console.log('[fastpath] albums=live_artist_surface');
              } catch (liveError) {
                console.warn('[albums live surface]', artist, liveError.message);
              }
            }

            if (!resolved) {
              resolved = await resolveMeloBotArtistAlbumsDirectFirst(
                tg,
                artist,
                seed,
                {
                  allowEmpty: true,
                  maxAlbums: 60,
                  directTimeoutMs: 6000,
                }
              );
              albumsRoute = resolved.source || 'direct_first';
            }

            sourceMs = Date.now() - sourceStartedAt;
            session.artistSeed = resolved.seed || session.artistSeed || seed || null;
            session.artistContext = {
              ...session.artistContext,
              ...(resolved.artistContext || {}),
              artist: resolved.artist,
              albumButton: resolved.artistContext?.albumButton
                ?? session.artistContext?.albumButton
                ?? null,
              albumList: resolved.albums || [],
              albumListingConfirmed: Boolean(resolved.confirmed),
              albumListingConfirmedEmpty: Boolean(resolved.confirmedEmpty),
              albumDeclaredCount: resolved.declaredCount ?? null,
            };
            session.albums = resolved.albums || [];
            session.albumsEmptyConfirmed = Boolean(
              resolved.confirmedEmpty && resolved.complete
            );

            if (!session.albums.length && !session.albumsEmptyConfirmed) {
              throw new Error('MeloBot returned no album rows without confirming an empty catalog.');
            }

            await syncAlbumIndex(resolved.artist, session.albums, {
              complete: Boolean(resolved.complete),
              emptyConfirmed: session.albumsEmptyConfirmed,
            });
          }
        }

        session.busy = false;
        const page = Math.max(0, job.page || 0);
        session.albumsPage = page;

        if (!session.albums.length) {
          await bot.editMessageText(
            session.chatId,
            job.messageId,
            `${session.artistContext.artist}\n💿 آلبوم‌ها\n\nبرای این خواننده آلبومی در منبع پیدا نشد.`,
            { reply_markup: noAlbumsKeyboard(job.sessionId) }
          );
          console.log(
            `[perf.albums] artist=${JSON.stringify(artist)} route=${albumsRoute} `
            + `cache_ms=${cacheMs} source_ms=${sourceMs} `
            + `total_ms=${Date.now() - albumsStartedAt} count=0`
          );
          return;
        }

        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `${session.artistContext.artist}\n💿 آلبوم‌ها`,
          { reply_markup: albumsKeyboard(job.sessionId, session.albums, page) }
        );

        console.log(
          `[perf.albums] artist=${JSON.stringify(artist)} route=${albumsRoute} `
          + `cache_ms=${cacheMs} source_ms=${sourceMs} `
          + `total_ms=${Date.now() - albumsStartedAt} count=${session.albums.length}`
        );
      } catch (err) {
        if (sourceStartedAt && !sourceMs) {
          sourceMs = Date.now() - sourceStartedAt;
        }
        console.error('[albums direct]', session.artistContext?.artist, err.message);
        console.log(
          `[perf.albums] artist=${JSON.stringify(session.artistContext?.artist || '')} `
          + `route=${albumsRoute} cache_ms=${cacheMs} source_ms=${sourceMs} `
          + `total_ms=${Date.now() - albumsStartedAt} error=true`
        );
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `${session.artistContext?.artist || 'خواننده'}\n💿 آلبوم‌ها\n\nدریافت آلبوم‌ها موقتاً ناموفق بود.`,
          { reply_markup: albumsErrorKeyboard(job.sessionId, session.albumsPage || 0) }
        );
      }
      return;
    }

    if (job.type === 'album') {
      try {
        const album = session.albums?.[job.index];
        if (!album || !session.artistContext?.artist) throw new Error('Album missing');

        let tracks = await catalog.getAlbumTracks(
          session.artistContext.artist,
          album.title,
          config.catalogAlbumTracksTtlMs
        );

        let liveAlbum = album;
        let resolvedArtist = session.artistContext.artist;

        let openedAlbumContext = null;

        if (!tracks) {
          const canUseLiveAlbumRow = Boolean(
            album.rawText
            && Number(album.sourceStateVersion || -1) === getMeloBotStateVersion()
          );

          if (canUseLiveAlbumRow) {
            openedAlbumContext = await openMeloBotAlbumContext(
              tg,
              session.artistContext.artist,
              album,
              { timeoutMs: 4500 }
            );
            resolvedArtist = openedAlbumContext.artist;
            liveAlbum = openedAlbumContext.album;
            tracks = openedAlbumContext.tracks;
            await syncAlbumTracks(resolvedArtist, liveAlbum, tracks);
            console.log('[fastpath] album_open=current_listing');
          } else {
            const seed = session.artistSeed || session.options.find(x =>
              x.source === 'melobot' &&
              normalize(x.artist) === normalize(session.artistContext.artist)
            ) || null;

            const openedStartedAt = Date.now();
            openedAlbumContext = await openMeloBotAlbumRobustByTitle(
              tg,
              session.artistContext.artist,
              album.title,
              {
                album,
                timeoutMs: 4500,
                maxPages: 12,
              }
            );

            resolvedArtist = openedAlbumContext.artist || session.artistContext.artist;
            liveAlbum = openedAlbumContext.album;
            tracks = openedAlbumContext.tracks;
            session.artistSeed = openedAlbumContext.seed || session.artistSeed || seed || null;
            await syncAlbumTracks(resolvedArtist, liveAlbum, tracks);

            console.log(
              `[perf.album_open] route=${openedAlbumContext.route || 'robust'} `
              + `open_ms=${Date.now() - openedStartedAt}`
            );
          }
        }

        session.artistContext = {
          ...session.artistContext,
          artist: resolvedArtist,
        };
        session.currentAlbum = {
          ...album,
          ...liveAlbum,
          artist: resolvedArtist,
          tracks,
          ...(openedAlbumContext ? {
            bulkHighButton: openedAlbumContext.bulkHighButton || null,
            bulkNormalButton: openedAlbumContext.bulkNormalButton || null,
            sourceStateVersion: openedAlbumContext.sourceStateVersion,
          } : {}),
        };
        session.currentAlbumView = 'artist';
        session.albumTrackPage = 0;
        session.albumsPage = Math.floor(job.index / ALBUMS_PER_PAGE);
        session.busy = false;

        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `💿 ${session.currentAlbum.title}\n${resolvedArtist}`,
          {
            reply_markup: albumTracksKeyboard(
              job.sessionId,
              tracks,
              session.albumsPage,
              0
            ),
          }
        );
      } catch (err) {
        console.error('[album direct]', err.message);
        session.busy = false;
        const page = session.albumsPage || 0;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `${session.artistContext?.artist || 'خواننده'}\n💿 آلبوم‌ها\n\nباز کردن آلبوم موقتاً ناموفق بود.`,
          { reply_markup: albumsErrorKeyboard(job.sessionId, page) }
        );
      }
      return;
    }

  } finally {
    if (job.sessionId && session && !session._deleted) {
      session.expiresAt = Date.now() + (session.busy ? BUSY_SESSION_TTL_MS : SESSION_TTL_MS);
      try { await sessions.set(job.sessionId,session); } catch (err) { console.warn('[session save]',err.message); }
    }
    const runMs = Date.now() - runStartedAt;
    console.log(
      `[perf] job=${job.type} queue_wait_ms=${queueWaitMs} run_ms=${runMs} total_ms=${queueWaitMs + runMs}`
    );
  }
}, { priorityOf: sourceJobPriority });
