import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { bot, cache, catalog, deepCatalog, follows, sessions, tg } from './runtime.js';
import { SerialQueue } from './queue.js';
import { applyPolicyDefaults } from './policy.js';
import {
  SESSION_TTL_MS, TOP_TRACKS_LIMIT, ALBUMS_PER_PAGE, normalize,
  resultsKeyboard, artistHomeKeyboard, artistSongsKeyboard,
  albumsKeyboard, albumTracksKeyboard, trackAlbumKeyboard,
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
  matchBulkAudioToTracks, listMeloBotAlbums,
  openMeloBotAlbum, downloadMeloBotTrack, discoverMeloBotHome,
} from './sources/melobot.js';
import { searchAhangify } from './sources/ahangify.js';
import { recordCrawlerStart, recordCrawlerFinish, setState } from './state.js';
import { executeDeepTask } from './deepCrawler.js';
import {
  renderTrackPage,
  sendTrackQuality,
  sendTrackLyrics,
  sendTrackCover,
  getTrackInfoText,
  getTrackAlbum,
} from './trackActions.js';

function newSessionId() { return randomBytes(4).toString('hex'); }

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
  await bot.editMessageText(session.chatId,messageId,`نتیجه‌ها برای «${session.query}»\nیک نسخه رو انتخاب کن:`,{
    reply_markup: resultsKeyboard(sessionId,session),
  });
}

export const sourceQueue = new SerialQueue(async job => {
  const session = job.sessionId ? await sessions.get(job.sessionId) : null;
  try {
    if (job.type === 'search') {
      try {
        const options = await searchPrimary(job.query);
        if (!options.length) throw new Error('No results');
        await catalog.recordSearch(job.query,options);
        for (const track of options) {
          try {
            await deepCatalog.upsertTrack(track,{ discoveredFrom: 'user:search' });
            await deepCatalog.seedTrackTasks(track,{
              priority: 112,
              includeMedia: false,
            });
          } catch (err) {
            console.warn('[deep seed search]', track.artist, track.title, err.message);
          }
        }
        const sessionId = newSessionId();
        const fresh = {
          chatId: job.chatId, userId: job.userId, query: job.query,
          messageId: job.statusMessageId, options, artistContext: null,
          artistSeed: null, isFollowing: false, albums: null,
          currentAlbum: null, currentAlbumView: null, albumsPage: 0,
          currentTrack: null, trackBack: null, artistBack: 'rs', busy: false,
          expiresAt: Date.now() + SESSION_TTL_MS,
        };
        await sessions.set(sessionId,fresh);
        await showResults(sessionId,fresh);
      } catch (err) {
        console.error('[search]',err.message);
        await bot.editMessageText(job.chatId,job.statusMessageId,'نتیجه‌ای پیدا نشد.');
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
        if (!cachedArtist) {
          await catalog.recordArtist(session.artistContext.artist, {
            topTracks: session.artistContext.topTracks || session.artistContext.tracks || [],
            recentTracks: session.artistContext.recentTracks || [],
            albumButton: session.artistContext.albumButton || null,
          });
        }
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
        session.busy = false;
        await bot.editMessageText(
          session.chatId,
          job.messageId,
          `💿 ${albumData.album.title}\n${albumData.album.artist || session.currentTrack.artist}`,
          { reply_markup: trackAlbumKeyboard(job.sessionId, albumData.album, albumData.tracks) }
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
          await catalog.recordArtist(liveArtist.artist,{
            topTracks: session.artistContext.topTracks || session.artistContext.tracks || [],
            recentTracks: liveArtist.recentTracks || [],
            albumButton: liveArtist.albumButton || null,
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
          await catalog.recordArtist(liveArtist.artist,{
            topTracks: liveArtist.topTracks || liveArtist.tracks || [],
            recentTracks: liveArtist.recentTracks || [],
            albumButton: liveArtist.albumButton || null,
          });

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

          try {
            await catalog.recordAlbumTracks(
              albumContext.artist,
              albumContext.album,
              albumContext.tracks
            );
            await deepCatalog.setAlbumTracks(
              albumContext.artist,
              albumContext.album,
              albumContext.tracks
            );
          } catch (err) {
            console.warn('[native bulk album catalog]', err.message);
          }

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
        ? trackAlbumKeyboard(job.sessionId, album, album?.tracks || [])
        : albumTracksKeyboard(job.sessionId, album?.tracks || [], session.albumsPage || 0);

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
            const tracks = extra.map(item => sourceCandidateToTrack({ ...item, source: 'ahangify' }));
            await catalog.recordSupplementalTracks(liveArtist.artist,tracks,'crawl:ahangify');
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
        if (!cachedArtist) {
          await catalog.recordArtist(session.artistContext.artist,{
            topTracks: session.artistContext.topTracks || session.artistContext.tracks || [],
            recentTracks: session.artistContext.recentTracks || [],
            albumButton: session.artistContext.albumButton || null,
          });
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
          const cachedAlbums = await catalog.getAlbums(session.artistContext.artist,config.catalogAlbumsTtlMs);
          if (cachedAlbums) session.albums = cachedAlbums;
          else {
            const seed = session.artistSeed || session.options.find(x =>
              x.source === 'melobot' && normalize(x.artist) === normalize(session.artistContext.artist));
            if (!seed) throw new Error('Artist seed missing for album navigation.');
            const liveArtist = await openMeloBotArtist(tg,seed);
            session.artistContext = { ...session.artistContext, albumButton: liveArtist.albumButton || null };
            session.albums = await listMeloBotAlbums(tg,session.artistContext);
            await catalog.recordAlbums(session.artistContext.artist,session.albums);
          }
        }
        session.busy = false;
        const page = Math.max(0,job.page || 0); session.albumsPage = page;
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
          await catalog.recordAlbums(session.artistContext.artist,liveAlbums);
          await catalog.recordAlbumTracks(session.artistContext.artist,liveAlbum,tracks);
        }
        session.currentAlbum = { ...album, tracks };
        session.currentAlbumView = 'artist';
        session.albumsPage = Math.floor(job.index / ALBUMS_PER_PAGE); session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,`💿 ${album.title}\n${session.artistContext.artist}`,{
          reply_markup: albumTracksKeyboard(job.sessionId,tracks,session.albumsPage),
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
