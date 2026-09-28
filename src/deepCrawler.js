import { config } from './config.js';
import { bridge, cache, catalog, deepCatalog, tg } from './runtime.js';
import { forwardHiddenToOurBot } from './mtproto.js';
import {
  discoverMeloBotFeed,
  downloadMeloBotTrackQuality,
  getMeloBotCover,
  getMeloBotLyrics,
  getMeloBotTrackMetadata,
  listMeloBotAlbums,
  openMeloBotAlbum,
  openMeloBotArtistFresh,
} from './sources/melobot.js';
import { deepNormalize } from './deepCatalog.js';
import { recordCrawlerFinish, recordCrawlerStart } from './state.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function captureForwardedMedia(message) {
  if (!message?.id) throw new Error('Source media message is missing.');
  const wait = bridge.expectMedia(25_000);
  await forwardHiddenToOurBot(tg, config.melobotUsername, message.id);
  return wait;
}

function dayBucket() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

async function enqueueArtistProfile(artist, seedTrack, priority = 100) {
  const name = clean(artist);
  if (!name) return;
  await deepCatalog.enqueueTask(
    'artist_profile',
    { artist: name, seedTrack: seedTrack || null },
    {
      priority,
      taskKey: `artist_profile:${deepNormalize(name)}:${dayBucket()}`,
    }
  );
}

async function seedTracks(tracks, priority, context = {}) {
  for (const sourceTrack of tracks || []) {
    const track = {
      ...sourceTrack,
      source: sourceTrack.source || 'melobot',
      ...(context.contentOrigin ? { contentOrigin: context.contentOrigin } : {}),
    };
    await deepCatalog.upsertTrack(track, {
      discoveredFrom: context.discoveredFrom,
      feed: context.feed,
      album: context.album,
    });
    await deepCatalog.seedTrackTasks(track, { priority });
  }
}

async function runFeed(task) {
  const { feed, origin = 'unknown' } = task.payload || {};
  if (!feed) throw new Error('Feed task is missing feed name.');

  const result = await discoverMeloBotFeed(tg, feed, { contentOrigin: origin });
  await seedTracks(result.tracks, feed === '/new' ? 100 : 92, {
    discoveredFrom: `feed:${feed}`,
    feed,
    contentOrigin: origin,
  });

  const artistMap = new Map();
  for (const track of result.tracks || []) {
    const key = deepNormalize(track.artist);
    if (key && !artistMap.has(key)) artistMap.set(key, track);
  }

  for (const track of artistMap.values()) {
    await enqueueArtistProfile(track.artist, track, feed === '/new' ? 108 : 98);
  }

  return { feed, tracks: result.tracks.length, artists: artistMap.size };
}

async function runArtistProfile(task) {
  const { artist, seedTrack = null } = task.payload || {};
  if (!artist) throw new Error('Artist profile task is missing artist.');

  const live = await openMeloBotArtistFresh(tg, artist, seedTrack);
  const recent = live.recentTracks || [];
  const top = live.topTracks || live.tracks || [];

  await catalog.recordArtist(live.artist, {
    topTracks: top,
    recentTracks: recent,
    albumButton: live.albumButton || null,
  });

  await deepCatalog.setArtistList(live.artist, 'recent', recent);
  await deepCatalog.setArtistList(live.artist, 'top', top);

  // New/recent songs get slightly higher cache priority, while top songs stay close behind.
  await seedTracks(recent, 105, { discoveredFrom: `artist_recent:${live.artist}` });
  await seedTracks(top, 100, { discoveredFrom: `artist_top:${live.artist}` });

  for (const related of live.relatedArtists || []) {
    if (deepNormalize(related) !== deepNormalize(live.artist)) {
      await enqueueArtistProfile(related, null, 82);
    }
  }

  if (live.albumButton) {
    await deepCatalog.enqueueTask(
      'album_index',
      { artist: live.artist, seedTrack: seedTrack || recent[0] || top[0] || null },
      { priority: 88, taskKey: `album_index:${deepNormalize(live.artist)}:${dayBucket()}` }
    );
  }

  return {
    artist: live.artist,
    recent: recent.length,
    top: top.length,
    relatedArtists: (live.relatedArtists || []).length,
    hasAlbums: Boolean(live.albumButton),
  };
}

async function runAlbumIndex(task) {
  const { artist, seedTrack = null } = task.payload || {};
  if (!artist) throw new Error('Album index task is missing artist.');

  const live = await openMeloBotArtistFresh(tg, artist, seedTrack);
  if (!live.albumButton) return { artist: live.artist, albums: 0 };

  const albums = await listMeloBotAlbums(tg, live);
  await catalog.recordAlbums(live.artist, albums);

  for (const album of albums) {
    await deepCatalog.upsertAlbum(live.artist, album);
    await deepCatalog.enqueueTask(
      'album_detail',
      { artist: live.artist, album, seedTrack: seedTrack || live.recentTracks?.[0] || live.topTracks?.[0] || null },
      {
        priority: 76,
        taskKey: `album_detail:${deepNormalize(live.artist)}:${deepNormalize(album.title)}`,
      }
    );
  }

  return { artist: live.artist, albums: albums.length };
}

async function runAlbumDetail(task) {
  const { artist, album, seedTrack = null } = task.payload || {};
  if (!artist || !album?.title) throw new Error('Album detail task is incomplete.');

  const live = await openMeloBotArtistFresh(tg, artist, seedTrack);
  const albums = await listMeloBotAlbums(tg, live);
  const target = albums.find(item => deepNormalize(item.title) === deepNormalize(album.title)) || album;
  const tracks = await openMeloBotAlbum(tg, live.artist, target);

  await catalog.recordAlbums(live.artist, albums);
  await catalog.recordAlbumTracks(live.artist, target, tracks);
  await deepCatalog.setAlbumTracks(live.artist, target, tracks);
  await seedTracks(tracks, 84, {
    discoveredFrom: `album:${target.title}`,
    album: target.title,
  });

  return { artist: live.artist, album: target.title, tracks: tracks.length };
}

async function runTrackHq(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('HQ task has no live MeloBot track reference.');

  const result = await downloadMeloBotTrackQuality(tg, track, 'hq');
  const media = await captureForwardedMedia(result.audioMessage);
  await deepCatalog.setMedia(track, 'hq', media, { source: 'melobot' });

  // HQ is also the default Navazon delivery cache.
  await cache.set(track, media, { sourceFetch: true });

  return { track: `${track.artist} — ${track.title}`, quality: 'hq', cached: true };
}

async function runTrackNormal(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Normal-quality task has no live MeloBot track reference.');

  const result = await downloadMeloBotTrackQuality(tg, track, 'normal');
  const media = await captureForwardedMedia(result.audioMessage);
  await deepCatalog.setMedia(track, 'normal', media, { source: 'melobot' });

  return { track: `${track.artist} — ${track.title}`, quality: 'normal', cached: true };
}

async function runTrackMetadata(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Metadata task has no live MeloBot track reference.');

  const metadata = await getMeloBotTrackMetadata(tg, track);
  await deepCatalog.setMetadata(track, metadata);
  return {
    track: `${track.artist} — ${track.title}`,
    releaseDate: metadata.releaseDate || metadata.releaseDateRaw || null,
    popularity: metadata.popularityCount || metadata.popularityText || null,
  };
}

async function runTrackCover(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Cover task has no live MeloBot track reference.');

  const cover = await getMeloBotCover(tg, track);
  if (!cover?.photoMessage) return { track: `${track.artist} — ${track.title}`, cover: false };

  const media = await captureForwardedMedia(cover.photoMessage);
  if (media.kind !== 'photo') throw new Error(`Expected photo cover, received ${media.kind}.`);
  await deepCatalog.setCover(track, media);
  return { track: `${track.artist} — ${track.title}`, cover: true };
}

async function runTrackLyrics(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Lyrics task has no live MeloBot track reference.');

  const lyrics = await getMeloBotLyrics(tg, track);
  if (lyrics.available && lyrics.text) {
    await deepCatalog.setLyrics(track, lyrics.text, 'melobot');
    return { track: `${track.artist} — ${track.title}`, lyrics: true, chars: lyrics.text.length };
  }

  await deepCatalog.markNoLyrics(track, 'melobot');
  return { track: `${track.artist} — ${track.title}`, lyrics: false };
}

export async function executeDeepTask(task) {
  const label = task?.kind || 'unknown';
  const runId = await recordCrawlerStart(`deep:${label}`);

  try {
    let summary;
    if (task.kind === 'feed') summary = await runFeed(task);
    else if (task.kind === 'artist_profile') summary = await runArtistProfile(task);
    else if (task.kind === 'album_index') summary = await runAlbumIndex(task);
    else if (task.kind === 'album_detail') summary = await runAlbumDetail(task);
    else if (task.kind === 'track_hq') summary = await runTrackHq(task);
    else if (task.kind === 'track_normal') summary = await runTrackNormal(task);
    else if (task.kind === 'track_metadata') summary = await runTrackMetadata(task);
    else if (task.kind === 'track_cover') summary = await runTrackCover(task);
    else if (task.kind === 'track_lyrics') summary = await runTrackLyrics(task);
    else throw new Error(`Unknown deep crawl task: ${task.kind}`);

    await deepCatalog.finishTask(task.id, summary);
    await recordCrawlerFinish(runId, { ok: true, summary: { kind: task.kind, ...summary } });
    console.log(`[deep crawler] done ${task.kind}`, summary);
    return summary;
  } catch (err) {
    const noPointRetrying = /button not found|no live MeloBot track reference|Expected photo cover/i.test(err.message || '');
    await deepCatalog.failTask(task.id, err.message, {
      retryDelayMs: noPointRetrying ? 24 * 60 * 60 * 1000 : config.discoveryRetryDelayMs,
      maxAttempts: noPointRetrying ? 2 : 4,
    });
    await recordCrawlerFinish(runId, { ok: false, error: err.message, summary: { kind: task.kind } });
    console.warn(`[deep crawler] failed ${task.kind}`, err.message);
    throw err;
  }
}
