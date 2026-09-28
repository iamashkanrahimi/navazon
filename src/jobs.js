import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { bot, cache, catalog, deepCatalog, follows, sessions, tg } from './runtime.js';
import { SerialQueue } from './queue.js';
import { applyPolicyDefaults } from './policy.js';
import {
  SESSION_TTL_MS, TOP_TRACKS_LIMIT, ALBUMS_PER_PAGE, normalize,
  homeKeyboard, newestMenuKeyboard, topMenuKeyboard,
  curatedPlaylistsKeyboard, followedArtistsKeyboard,
  resultsKeyboard, artistHomeKeyboard, artistSongsKeyboard,
  albumsKeyboard, noAlbumsKeyboard, albumTracksKeyboard, trackAlbumKeyboard,
} from './ui.js';
import {
  assertDeliveryAllowed, bridgeSourceAudio, bridgeSourceMessage, bridgeSourceMessages,
  deliverCached, downloadTrackWithSources, searchPrimary, sendMedia,
  sourceCandidateToTrack,
} from './media.js';
import {
  openMeloBotArtist, openMeloBotArtistFresh,
  prepareMeloBotBulkTopTracks, prepareMeloBotBulkRecentTracks, prepareMeloBotBulkAlbum,
  downloadMeloBotTopTracks, downloadMeloBotRecentTracks, downloadMeloBotAlbumTracks,
  matchBulkAudioToTracks, listMeloBotAlbums, resolveMeloBotAlbums,
  discoverMeloBotAlbumsForQuery, discoverMeloBotAlbumsByArtistQuery,
  discoverMeloBotFeed, openMeloBotCuratedPlaylist,
  openMeloBotAlbum, downloadMeloBotTrack, discoverMeloBotHome,
} from './sources/melobot.js';
import { searchAhangify } from './sources/ahangify.js';
import { recordCrawlerStart, recordCrawlerFinish, setState } from './state.js';
import { executeDeepTask } from './deepCrawler.js';
import { HOME_FEEDS, curatedPlaylistByKey } from './homeCatalog.js';
import {
  renderTrackPage,
  sendTrackQuality,
  sendTrackLyrics,
  sendTrackCover,
  getTrackInfoText,
  getTrackAlbum,
} from './trackActions.js';

function newSessionId() { return randomBytes(4).toString('hex'); }

async function syncArtistContext(artistContext) {
  if (!artistContext?.artist) return;
  const topTracks = artistContext.topTracks || artistContext.tracks || [];
  const recentTracks = artistContext.recentTracks || [];

  const results = await Promise.allSettled([
    catalog.recordArtist(artistContext.artist, {
      topTracks,
      recentTracks,
      albumButton: artistContext.albumButton || null,
    }),
    deepCatalog.setArtistList(artistContext.artist, 'top', topTracks),
    deepCatalog.setArtistList(artistContext.artist, 'recent', recentTracks),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[artist sync]', artistContext.artist, result.reason?.message || result.reason);
    }
  }
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

function isAlbumIntentQuery(query = '') {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  return tokens.includes('album') || tokens.includes('آلبوم');
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
  const albumIntent = isAlbumIntentQuery(query);
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
        return mergeAlbumResults(
          limit,
          fullCached.map(album => ({ ...album, artist: artists[0], source: 'catalog' })),
          albums
        );
      }
    }
  }

  // Explicit "album + artist" queries should work even when track search
  // returns no usable MeloBot seed. Resolve the source's artist picker directly.
  if (albumIntent) {
    try {
      const direct = await discoverMeloBotAlbumsByArtistQuery(tg, query, {
        maxAlbums: limit,
      });
      if (direct.artist) {
        await syncAlbumIndex(direct.artist, direct.albums, {
          complete: Boolean(direct.complete),
          emptyConfirmed: Boolean(direct.confirmedEmpty && direct.complete),
        });
        albums = mergeAlbumResults(
          limit,
          direct.albums.map(album => ({ ...album, artist: direct.artist, source: 'melobot' })),
          albums
        );
      }
    } catch (err) {
      console.warn('[direct album search]', err.message);
    }

    return albums;
  }

  if (albums.length >= limit) return albums;

  const q = normalize(query);
  const melobotSeeds = (tracks || []).filter(track =>
    track?.source === 'melobot' && track?.rawText && track?.artist
  );
  const artistMentioned = melobotSeeds.some(track =>
    q.includes(normalize(track.artist))
  );
  const shouldTryLive = melobotSeeds.length && (
    artistMentioned || q.split(/\s+/).filter(Boolean).length >= 2
  );

  if (shouldTryLive) {
    try {
      const liveAlbums = await discoverMeloBotAlbumsForQuery(
        tg,
        query,
        melobotSeeds,
        { maxArtists: 2, maxAlbums: limit }
      );

      const grouped = new Map();
      for (const album of liveAlbums) {
        const key = normalize(album.artist);
        const group = grouped.get(key) || { artist: album.artist, albums: [] };
        group.albums.push(album);
        grouped.set(key, group);
      }
      await Promise.all([...grouped.values()].map(group =>
        syncAlbumIndex(group.artist, group.albums, { complete: false })
      ));

      albums = mergeAlbumResults(limit, albums, liveAlbums);
    } catch (err) {
      console.warn('[album search discovery]', err.message);
    }
  }

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

  if (sourceMatches.length) {
    try {
      const bridged = await bridgeSourceMessages(
        config.melobotUsername,
        sourceMatches.map(item => item.audioItem.message)
      );

      const bridgedMatches = matchBulkAudioToTracks(
        sourceMatches.map(item => item.track),
        bridged.items || []
      );

      for (const { track: sourceTrack, audioItem: media } of bridgedMatches) {
        const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
        const key = bulkTrackKey(track);
        mediaByTrack.set(key, media);
        try {
          await Promise.all([
            cache.set(track, media, { sourceFetch: true }),
            deepCatalog.setMedia(track, 'hq', media, { source: 'melobot', satisfiedBy: label }),
          ]);
        } catch (err) {
          console.warn(`[${label} cache]`, track.artist, track.title, err.message);
        }
      }
    } catch (err) {
      console.warn(`[${label} batch bridge]`, err.message);
    }
  }

  let sent = 0;
  let missing = 0;
  for (const sourceTrack of sourceTracks) {
    const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
    try {
      assertDeliveryAllowed(track, session.userRegion || 'unknown');
      const media = mediaByTrack.get(bulkTrackKey(track));
      if (media) {
        await sendMedia(session.chatId, track, media);
        sent += 1;
        continue;
      }

      const cached = await cache.get(track);
      if (cached) {
        await deliverCached(session.chatId, track, cached);
        sent += 1;
      } else {
        missing += 1;
      }
    } catch (err) {
      console.warn(`[${label} deliver]`, track.artist, track.title, err.message);
      missing += 1;
    }
  }

  return { sent, missing, matched: sourceMatches.length };
}

async function deliverBulkFromCacheIfComplete(session, tracks) {
  const sourceTracks = (tracks || []).slice();
  if (!sourceTracks.length) return { complete: false, sent: 0 };
  const cached = await Promise.all(sourceTracks.map(track => cache.get(track)));
  if (!cached.every(Boolean)) return { complete: false, sent: 0 };

  let sent = 0;
  for (let index = 0; index < sourceTracks.length; index += 1) {
    const track = applyPolicyDefaults({ ...sourceTracks[index], source: 'melobot' });
    assertDeliveryAllowed(track, session.userRegion || 'unknown');
    await deliverCached(session.chatId, track, cached[index]);
    sent += 1;
  }
  return { complete: true, sent };
}



async function deliverAvailableBulkCache(session, tracks) {
  let sent = 0;
  let missing = 0;
  for (const sourceTrack of tracks || []) {
    const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
    try {
      assertDeliveryAllowed(track, session.userRegion || 'unknown');
      const cached = await cache.get(track);
      if (!cached) {
        missing += 1;
        continue;
      }
      await deliverCached(session.chatId, track, cached);
      sent += 1;
    } catch {
      missing += 1;
    }
  }
  return { sent, missing };
}

export async function showResults(sessionId, session, messageId = session.messageId) {
  const prompt = session.resultsPrompt || (
    session.albumOptions?.length
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
  const session = job.sessionId ? await sessions.get(job.sessionId) : null;
  try {
    if (job.type === 'search') {
      try {
        const albumIntent = isAlbumIntentQuery(job.query);
        const cachedOptions = albumIntent
          ? null
          : await catalog.getSearch(job.query, config.catalogSearchTtlMs);
        let options = cachedOptions || [];

        if (!albumIntent && !cachedOptions) {
          try {
            options = await searchPrimary(job.query);
          } catch (err) {
            console.warn('[track search]', err.message);
            options = [];
          }
        }

        const albumOptions = await searchAlbumOptions(job.query, options);
        if (!options.length && !albumOptions.length) throw new Error('No results');

        const albumFirst = albumIntent && albumOptions.length > 0;
        const sessionId = newSessionId();
        const fresh = {
          chatId: job.chatId, userId: job.userId, query: job.query,
          messageId: job.statusMessageId, options, albumOptions, albumFirst, artistContext: null,
          artistSeed: null, isFollowing: false, albums: null,
          currentAlbum: null, currentAlbumView: null, albumsPage: 0, albumTrackPage: 0,
          currentTrack: null, trackBack: null, artistBack: 'rs', busy: false,
          expiresAt: Date.now() + SESSION_TTL_MS,
        };
        await sessions.set(sessionId,fresh);
        await showResults(sessionId,fresh);

        if (!albumIntent && !cachedOptions && options.length) {
          try { await catalog.recordSearch(job.query,options); } catch (err) {
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
        session.artistContext = cachedArtist || await openMeloBotArtistFresh(tg, artist, null);
        session.artistSeed = (
          session.artistContext.recentTracks?.[0] ||
          session.artistContext.topTracks?.[0] ||
          session.artistContext.tracks?.[0] ||
          null
        );
        await syncArtistContext(session.artistContext);
        session.isFollowing = await follows.isFollowing(session.userId, session.artistContext.artist);
        session.artistBack = 'hfol';
        session.albums = null;
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
        await executeDeepTask(job.task);
      } catch (err) {
        console.warn('[deep crawl job]', err.message);
      }
      return;
    }

    if (!session && !['discover','discover_bootstrap'].includes(job.type)) return;
    if (session) session.expiresAt = Date.now() + SESSION_TTL_MS;

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
        if (!tracks.length) {
          const seed = session.options?.find(track =>
            track.source === 'melobot' &&
            normalize(track.artist) === normalize(album.artist)
          ) || null;

          let liveArtistName = album.artist;
          let liveAlbums = [];

          if (seed) {
            const liveArtist = await openMeloBotArtistFresh(tg, album.artist, seed);
            liveArtistName = liveArtist.artist;
            session.artistSeed = seed
              || liveArtist.recentTracks?.[0]
              || liveArtist.topTracks?.[0]
              || null;
            await syncArtistContext(liveArtist);

            const resolved = await resolveMeloBotAlbums(
              tg,
              liveArtist,
              { allowEmpty: true }
            );
            liveAlbums = resolved.albums;
            await syncAlbumIndex(liveArtist.artist, liveAlbums, {
              complete: Boolean(resolved.complete),
              emptyConfirmed: Boolean(resolved.confirmedEmpty && resolved.complete),
            });
          } else {
            // Album-only searches deliberately skip track search. Re-open the
            // source's artist picker/list directly so an album can still be
            // opened even when no seed track exists in the session.
            const direct = await discoverMeloBotAlbumsByArtistQuery(
              tg,
              `album ${album.artist}`,
              { maxAlbums: 30 }
            );
            liveArtistName = direct.artist || album.artist;
            liveAlbums = direct.albums || [];
            await syncAlbumIndex(liveArtistName, liveAlbums, {
              complete: Boolean(direct.complete),
              emptyConfirmed: Boolean(direct.confirmedEmpty && direct.complete),
            });
          }

          liveAlbum = liveAlbums.find(item =>
            normalize(item.title) === normalize(album.title)
          ) || null;
          if (!liveAlbum) {
            throw new Error(`Album disappeared from live source: ${album.title}`);
          }

          tracks = await openMeloBotAlbum(tg, liveArtistName, liveAlbum);
          await syncAlbumTracks(liveArtistName, liveAlbum, tracks);
        }

        session.currentAlbum = {
          ...liveAlbum,
          ...album,
          artist: album.artist,
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
        await sendTrackQuality(
          session.chatId,
          session.currentTrack,
          job.quality,
          session.userRegion || 'unknown'
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

    if (job.type === 'track_artist') {
      try {
        const seed = session.currentTrack;
        if (!seed?.artist) throw new Error('Track artist is missing.');

        const cachedArtist = await catalog.getArtistContext(seed.artist, config.catalogArtistTtlMs);
        session.artistContext = cachedArtist || await openMeloBotArtistFresh(
          tg,
          seed.artist,
          seed.source === 'melobot' ? seed : null
        );
        session.artistSeed = seed.source === 'melobot'
          ? seed
          : (session.artistContext.recentTracks?.[0] || session.artistContext.topTracks?.[0] || null);
        await syncArtistContext(session.artistContext);
        session.isFollowing = await follows.isFollowing(session.userId, session.artistContext.artist);
        session.artistBack = 'trt';
        session.albums = null;
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
      } catch (err) {
        console.error('[track artist]', err.message);
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
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              liveArtist = await prepareMeloBotBulkRecentTracks(
                tg,
                session.artistContext.artist,
                seed
              );
              bulk = await downloadMeloBotRecentTracks(tg, liveArtist);
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk recent retry]', attempt + 1, err.message);
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
        }
      } catch (err) {
        console.warn('[native bulk recent failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        if (missing) {
          await bot.sendMessage(
            session.chatId,
            'دانلود یکجای جدیدترین‌ها از منبع انجام نشد؛ فایل‌های موجود در کش ارسال شدند. دوباره امتحان کن.'
          );
        }
      }

      session.busy = false;
      await bot.editMessageText(
        session.chatId,
        job.messageId,
        `${session.artistContext.artist}\n🆕 جدیدترین آهنگ‌ها`,
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
        session.artistContext?.topTracks ||
        session.artistContext?.tracks ||
        []
      ).slice(0, TOP_TRACKS_LIMIT);
      let sent = 0;
      let missing = 0;

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
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              liveArtist = await prepareMeloBotBulkTopTracks(
                tg,
                session.artistContext.artist,
                seed
              );
              bulk = await downloadMeloBotTopTracks(tg, liveArtist);
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk top retry]', attempt + 1, err.message);
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
        }
      } catch (err) {
        console.warn('[native bulk top failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        if (missing) {
          await bot.sendMessage(
            session.chatId,
            'دانلود یکجای پربازدیدترین‌ها از منبع انجام نشد؛ فایل‌های موجود در کش ارسال شدند. دوباره امتحان کن.'
          );
        }
      }

      session.busy = false;
      const tracks = session.artistContext?.topTracks || session.artistContext?.tracks || requestedTracks;
      await bot.editMessageText(
        session.chatId,
        job.messageId,
        `${session.artistContext.artist}\n🎵 پربازدیدترین آهنگ‌ها`,
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
          const seed = session.artistSeed
            || session.albumOriginTrack
            || session.currentTrack
            || session.options?.find(x =>
              x.source === 'melobot' &&
              (!artist || normalize(x.artist) === normalize(artist))
            );

          if (!artist || !albumTitle || !seed) {
            throw new Error('Album artist/seed missing for native bulk HQ.');
          }

          let albumContext;
          let bulk;
          let lastError;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              albumContext = await prepareMeloBotBulkAlbum(tg, artist, albumTitle, seed);
              bulk = await downloadMeloBotAlbumTracks(tg, albumContext);
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              console.warn('[native bulk album retry]', attempt + 1, err.message);
            }
          }
          if (lastError || !albumContext || !bulk) throw lastError || new Error('Album native bulk failed.');

          session.currentAlbum = {
            ...session.currentAlbum,
            ...albumContext.album,
            artist: albumContext.artist,
            tracks: albumContext.tracks,
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
        }
      } catch (err) {
        console.warn('[native bulk album failed]', err.message);
        const fallback = await deliverAvailableBulkCache(session, requestedTracks);
        sent = fallback.sent;
        missing = fallback.missing;
        if (missing) {
          await bot.sendMessage(
            session.chatId,
            'دانلود یکجای آلبوم از منبع انجام نشد؛ فایل‌های موجود در کش ارسال شدند. دوباره امتحان کن.'
          );
        }
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
        const liveArtist = await openMeloBotArtistFresh(tg,candidate.artist,
          candidate.seedTrack ? { ...candidate.seedTrack, source: 'melobot' } : null);
        await catalog.recordArtist(liveArtist.artist,{
          topTracks: liveArtist.topTracks || liveArtist.tracks || [],
          recentTracks: liveArtist.recentTracks || [], albumButton: liveArtist.albumButton || null,
        });
        for (const relatedArtist of liveArtist.relatedArtists || []) {
          if (normalize(relatedArtist) !== normalize(liveArtist.artist)) {
            await catalog.ensureArtist(relatedArtist,{ discoveredFrom: `artist-picker:${liveArtist.artist}` });
          }
        }
        if (config.discoveryUseAhangify) {
          try {
            const extra = await searchAhangify(tg,liveArtist.artist);
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
              await catalog.recordSupplementalTracks(liveArtist.artist,tracks,'crawl:ahangify');
            }
          } catch (err) { console.warn('[crawler ahangify]',liveArtist.artist,err.message); }
        }
        let albums = [];
        try {
          albums = await listMeloBotAlbums(tg,liveArtist);
          await catalog.recordAlbums(liveArtist.artist,albums);
        } catch (err) { console.warn('[crawler albums]',liveArtist.artist,err.message); }

        let openedAlbums = 0;
        while (openedAlbums < config.discoveryAlbumsPerRun && albums.length) {
          const album = await catalog.firstStaleAlbum(liveArtist.artist,albums,config.catalogAlbumTracksTtlMs);
          if (!album) break;
          try {
            const freshArtist = await openMeloBotArtistFresh(tg,liveArtist.artist,candidate.seedTrack || null);
            const freshAlbums = await listMeloBotAlbums(tg,freshArtist);
            const target = freshAlbums.find(x => normalize(x.title) === normalize(album.title)) || album;
            const tracks = await openMeloBotAlbum(tg,liveArtist.artist,target);
            await catalog.recordAlbums(liveArtist.artist,freshAlbums);
            await catalog.recordAlbumTracks(liveArtist.artist,target,tracks);
            albums = freshAlbums;
            openedAlbums += 1;
          } catch (err) { console.warn('[crawler album]',liveArtist.artist,album.title,err.message); break; }
        }

        if (config.discoveryWarmTopTracks > 0) {
          for (const sourceTrack of (liveArtist.topTracks || []).slice(0,config.discoveryWarmTopTracks)) {
            const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
            try {
              if (await cache.has(track)) continue;
              const result = await downloadMeloBotTrack(tg,track);
              await bridgeSourceAudio(config.melobotUsername,result,track);
            } catch (err) { console.warn('[crawler warm]',track.artist,track.title,err.message); }
          }
        }

        const staleAlbums = albums.length
          ? await catalog.staleAlbumCount(liveArtist.artist,albums,config.catalogAlbumTracksTtlMs) : 0;
        await catalog.markDiscoveryChecked(liveArtist.artist,{
          ok: true, nextDelayMs: staleAlbums > 0 ? config.discoveryContinueDelayMs : null,
        });
        const summary = { top: (liveArtist.topTracks || []).length, albums: albums.length, staleAlbums };
        await recordCrawlerFinish(runId,{ ok: true, summary });
        console.log(`[crawler] ${liveArtist.artist}: top=${summary.top}, albums=${summary.albums}, stale=${summary.staleAlbums}`);
      } catch (err) {
        console.warn('[crawler]',candidate.artist,err.message);
        await catalog.markDiscoveryChecked(candidate.artist,{
          ok: false, error: err.message, nextDelayMs: config.discoveryRetryDelayMs,
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

    if (job.type === 'artist') {
      try {
        const indexedSeed = Number.isInteger(job.seedIndex) && job.seedIndex >= 0
          ? session.options?.[job.seedIndex]
          : null;
        const seed = indexedSeed?.source === 'melobot'
          ? indexedSeed
          : session.options.find(x => x.source === 'melobot');
        if (!seed) throw new Error('Artist profile currently requires MeloBot result.');
        session.artistSeed = seed;
        const cachedArtist = await catalog.getArtistContext(seed.artist,config.catalogArtistTtlMs);
        session.artistContext = cachedArtist || await openMeloBotArtist(tg,seed);
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
        session.albums = null; session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(job.sessionId,session.artistContext,session.isFollowing,{ backAction: session.artistBack || 'rs' }),
        });
      } catch (err) {
        console.error('[artist]',err.message); session.busy = false;
        await showResults(job.sessionId,session,job.messageId);
      }
      return;
    }

    if (job.type === 'albums') {
      try {
        if (!session.artistContext) throw new Error('Artist context missing');
        if (!session.albums) {
          const cachedAlbums = await catalog.getAlbums(
            session.artistContext.artist,
            config.catalogAlbumsTtlMs,
            config.catalogEmptyAlbumsTtlMs
          );

          if (cachedAlbums) {
            session.albums = cachedAlbums;
          } else {
            const seed = session.artistSeed || session.options.find(x =>
              x.source === 'melobot' && normalize(x.artist) === normalize(session.artistContext.artist));
            if (!seed) throw new Error('Artist seed missing for album navigation.');

            const liveArtist = await openMeloBotArtist(tg,seed);
            session.artistContext = {
              ...session.artistContext,
              artist: liveArtist.artist || session.artistContext.artist,
              albumButton: liveArtist.albumButton || null,
              albumList: liveArtist.albumList || [],
              albumListingConfirmed: Boolean(liveArtist.albumListingConfirmed),
              albumListingConfirmedEmpty: Boolean(liveArtist.albumListingConfirmedEmpty),
              albumDeclaredCount: liveArtist.albumDeclaredCount ?? null,
            };

            // The artist page may already be the album-list page. Resolve it
            // without pressing one of the album rows as if it were navigation.
            const resolvedAlbums = await resolveMeloBotAlbums(
              tg,
              session.artistContext,
              { allowEmpty: true }
            );
            session.albums = resolvedAlbums.albums;

            await syncAlbumIndex(session.artistContext.artist, session.albums, {
              complete: Boolean(resolvedAlbums.complete),
              emptyConfirmed: Boolean(
                resolvedAlbums.confirmedEmpty && resolvedAlbums.complete
              ),
            });
          }
        }

        session.busy = false;
        const page = Math.max(0,job.page || 0);
        session.albumsPage = page;

        if (!session.albums.length) {
          await bot.editMessageText(
            session.chatId,
            job.messageId,
            `${session.artistContext.artist}\n💿 آلبوم‌ها\n\nبرای این خواننده آلبومی در منبع پیدا نشد.`,
            { reply_markup: noAlbumsKeyboard(job.sessionId) }
          );
          return;
        }

        await bot.editMessageText(session.chatId,job.messageId,`${session.artistContext.artist}\n💿 آلبوم‌ها`,{
          reply_markup: albumsKeyboard(job.sessionId,session.albums,page),
        });
      } catch (err) {
        console.error('[albums]',err.message); session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,session.artistContext?.artist || 'خواننده',{
          reply_markup: artistHomeKeyboard(job.sessionId,session.artistContext || { tracks: [] },session.isFollowing,{ backAction: session.artistBack || 'rs' }),
        });
      }
      return;
    }

    if (job.type === 'album') {
      try {
        const album = session.albums?.[job.index];
        if (!album || !session.artistContext) throw new Error('Album missing');
        let tracks = await catalog.getAlbumTracks(session.artistContext.artist,album.title,config.catalogAlbumTracksTtlMs);
        if (!tracks) {
          const seed = session.artistSeed || session.options.find(x =>
            x.source === 'melobot' && normalize(x.artist) === normalize(session.artistContext.artist));
          if (!seed) throw new Error('Artist seed missing for album navigation.');
          const liveArtist = await openMeloBotArtist(tg,seed);
          const liveAlbums = await listMeloBotAlbums(tg,liveArtist);
          const liveAlbum = liveAlbums.find(x => normalize(x.title) === normalize(album.title)) || album;
          tracks = await openMeloBotAlbum(tg,session.artistContext.artist,liveAlbum);
          await syncAlbumIndex(session.artistContext.artist, liveAlbums);
          await syncAlbumTracks(session.artistContext.artist, liveAlbum, tracks);
        }
        session.currentAlbum = { ...album, tracks };
        session.currentAlbumView = 'artist';
        session.albumTrackPage = 0;
        session.albumsPage = Math.floor(job.index / ALBUMS_PER_PAGE); session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,`💿 ${album.title}\n${session.artistContext.artist}`,{
          reply_markup: albumTracksKeyboard(job.sessionId,tracks,session.albumsPage,0),
        });
      } catch (err) {
        console.error('[album]',err.message); session.busy = false;
        const page = session.albumsPage || 0;
        await bot.editMessageText(session.chatId,job.messageId,`${session.artistContext?.artist || 'خواننده'}\n💿 آلبوم‌ها`,{
          reply_markup: albumsKeyboard(job.sessionId,session.albums || [],page),
        });
      }
    }
  } finally {
    if (job.sessionId && session && !session._deleted) {
      try { await sessions.set(job.sessionId,session); } catch (err) { console.warn('[session save]',err.message); }
    }
  }
});
