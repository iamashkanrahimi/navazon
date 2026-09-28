import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { bot, cache, catalog, follows, sessions, tg } from './runtime.js';
import { SerialQueue } from './queue.js';
import { applyPolicyDefaults } from './policy.js';
import {
  SESSION_TTL_MS, TOP_TRACKS_LIMIT, ALBUMS_PER_PAGE, normalize,
  resultsKeyboard, artistHomeKeyboard, artistSongsKeyboard,
  albumsKeyboard, albumTracksKeyboard,
} from './ui.js';
import {
  assertDeliveryAllowed, bridgeSourceAudio, bridgeSourceMessage,
  deliverCached, downloadTrackWithSources, searchPrimary, sendMedia,
  sourceCandidateToTrack,
} from './media.js';
import {
  openMeloBotArtist, openMeloBotArtistFresh, prepareMeloBotBulkTopTracks,
  downloadMeloBotTopTracks, matchBulkAudioToTracks, listMeloBotAlbums,
  openMeloBotAlbum, downloadMeloBotTrack, discoverMeloBotHome,
} from './sources/melobot.js';
import { searchAhangify } from './sources/ahangify.js';
import { recordCrawlerStart, recordCrawlerFinish, setState } from './state.js';

function newSessionId() { return randomBytes(4).toString('hex'); }

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
        const sessionId = newSessionId();
        const fresh = {
          chatId: job.chatId, userId: job.userId, query: job.query,
          messageId: job.statusMessageId, options, artistContext: null,
          artistSeed: null, isFollowing: false, albums: null,
          currentAlbum: null, albumsPage: 0, busy: false,
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

    if (!session && !['discover','discover_bootstrap'].includes(job.type)) return;
    if (session) session.expiresAt = Date.now() + SESSION_TTL_MS;

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
      const tracks = session.artistContext?.tracks?.slice(0,TOP_TRACKS_LIMIT) || [];
      let sent = 0;
      try {
        const cachedEntries = await Promise.all(tracks.map(track => cache.get(track)));
        const allCached = cachedEntries.length > 0 && cachedEntries.every(Boolean);
        if (allCached) {
          for (let i=0;i<tracks.length;i+=1) {
            const track = applyPolicyDefaults({ ...tracks[i], source: 'melobot' });
            assertDeliveryAllowed(track,session.userRegion || 'unknown');
            await deliverCached(session.chatId,track,cachedEntries[i]);
            sent += 1;
          }
        } else {
          const seed = session.artistSeed || session.options.find(x =>
            x.source === 'melobot' && normalize(x.artist) === normalize(session.artistContext.artist)
          );
          if (!seed) throw new Error('Artist seed missing for bulk HQ.');
          const liveArtist = await prepareMeloBotBulkTopTracks(tg,session.artistContext.artist,seed);
          session.artistContext = { ...session.artistContext, ...liveArtist };
          await catalog.recordArtist(liveArtist.artist,{
            topTracks: liveArtist.topTracks || liveArtist.tracks || [],
            recentTracks: liveArtist.recentTracks || [],
            albumButton: liveArtist.albumButton || null,
          });
          const bulk = await downloadMeloBotTopTracks(tg,liveArtist);
          const matches = matchBulkAudioToTracks(tracks,bulk.audioItems);
          const mediaByTrack = new Map();
          for (const { track: sourceTrack, audioItem } of matches) {
            const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
            try {
              assertDeliveryAllowed(track,session.userRegion || 'unknown');
              const media = await bridgeSourceMessage(config.melobotUsername,audioItem.message,track);
              mediaByTrack.set(track.rawText || `${normalize(track.artist)}|${normalize(track.title)}`,media);
            } catch (err) { console.warn('[bulk bridge]',track.artist,track.title,err.message); }
          }
          for (const sourceTrack of tracks) {
            const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
            try {
              assertDeliveryAllowed(track,session.userRegion || 'unknown');
              const key = track.rawText || `${normalize(track.artist)}|${normalize(track.title)}`;
              const media = mediaByTrack.get(key);
              if (media) await sendMedia(session.chatId,track,media);
              else {
                const cached = await cache.get(track);
                if (cached) await deliverCached(session.chatId,track,cached);
                else {
                  const outcome = await downloadTrackWithSources(track,session.query);
                  if (outcome.cached) await deliverCached(session.chatId,outcome.track,outcome.cached);
                  else await sendMedia(session.chatId,outcome.track,outcome.media);
                }
              }
              sent += 1;
            } catch (err) { console.warn('[download top]',track.artist,track.title,err.message); }
          }
        }
      } catch (err) {
        console.warn('[bulk HQ fallback]',err.message);
        for (const sourceTrack of tracks) {
          const track = applyPolicyDefaults({ ...sourceTrack, source: 'melobot' });
          try {
            assertDeliveryAllowed(track,session.userRegion || 'unknown');
            const outcome = await downloadTrackWithSources(track,session.query);
            if (outcome.cached) await deliverCached(session.chatId,outcome.track,outcome.cached);
            else await sendMedia(session.chatId,outcome.track,outcome.media);
            sent += 1;
          } catch (inner) { console.warn('[download top fallback]',track.artist,track.title,inner.message); }
        }
      }
      session.busy = false;
      await bot.editMessageText(session.chatId,job.messageId,`${session.artistContext.artist}\n🎵 پربازدیدترین آهنگ‌ها`,{
        reply_markup: artistSongsKeyboard(job.sessionId,session.artistContext.tracks),
      });
      if (!sent) console.warn('[download top] no tracks were delivered');
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
        const seed = session.options.find(x => x.source === 'melobot');
        if (!seed) throw new Error('Artist profile currently requires MeloBot result.');
        session.artistSeed = seed;
        const cachedArtist = await catalog.getArtistContext(seed.artist,config.catalogArtistTtlMs);
        session.artistContext = cachedArtist || await openMeloBotArtist(tg,seed);
        if (!cachedArtist) await catalog.recordArtist(session.artistContext.artist,{
          topTracks: session.artistContext.topTracks || session.artistContext.tracks || [],
          recentTracks: session.artistContext.recentTracks || [],
          albumButton: session.artistContext.albumButton || null,
        });
        session.isFollowing = await follows.isFollowing(session.userId,session.artistContext.artist);
        session.albums = null; session.busy = false;
        await bot.editMessageText(session.chatId,job.messageId,session.artistContext.artist,{
          reply_markup: artistHomeKeyboard(job.sessionId,session.artistContext,session.isFollowing),
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
          reply_markup: artistHomeKeyboard(job.sessionId,session.artistContext || { tracks: [] },session.isFollowing),
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
