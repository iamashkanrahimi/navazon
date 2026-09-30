import { config } from './config.js';
import { bridge, cache, catalog, deepCatalog, tg } from './runtime.js';
import { forwardHiddenToOurBot, forwardHiddenManyToOurBot } from './mtproto.js';
import {
  discoverMeloBotFeed,
  discoverMeloBotHome,
  discoverMeloBotPlaylists,
  downloadMeloBotTrackQuality,
  downloadMeloBotBulkTracks,
  enrichMeloBotTrack,
  getMeloBotCover,
  getMeloBotLyrics,
  getMeloBotTrackMetadata,
  listMeloBotAlbums,
  resolveMeloBotAlbums,
  resolveMeloBotArtistAlbums,
  resolveMeloBotArtistAlbumsDirectFirst,
  resolveMeloBotTrackCandidate,
  matchBulkAudioToTracks,
  openMeloBotAlbum,
  openMeloBotAlbumContext,
  openMeloBotAlbumByTitle,
  openMeloBotAlbumRobustByTitle,
  openMeloBotArtistFresh,
  prepareMeloBotBulkAlbum,
  prepareMeloBotBulkRecentTracks,
  prepareMeloBotBulkTopTracks,
} from './sources/melobot.js';
import { deepNormalize, deepTrackKey } from './deepCatalog.js';
import { recordCrawlerFinish, recordCrawlerStart } from './state.js';
import { hasCompositeArtistSeparators } from './text.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function captureForwardedMedia(message) {
  if (!message?.id) throw new Error('Source media message is missing.');
  const wait = bridge.expectMedia(10_000);
  await forwardHiddenToOurBot(tg, config.melobotUsername, message.id);
  return wait;
}

async function captureForwardedMediaBatch(messages = []) {
  const ids = (messages || []).map(message => Number(message?.id)).filter(Number.isFinite);
  if (!ids.length) return { items: [], complete: true, expected: 0 };

  const timeoutMs = Math.max(12_000, Math.min(25_000, 7_000 + ids.length * 2_000));
  const wait = bridge.expectManyMedia(ids.length, timeoutMs);
  await forwardHiddenManyToOurBot(tg, config.melobotUsername, ids);
  return wait;
}

function dayBucket() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

function albumRefreshBucket() {
  return Math.floor(Date.now() / (30 * 24 * 60 * 60 * 1000));
}

async function enqueueArtistProfile(
  artist,
  seedTrack,
  priority = 100,
  { sourceBackedArtist = false } = {}
) {
  const name = clean(artist);
  if (!name) return;
  await deepCatalog.enqueueTask(
    'artist_profile',
    {
      artist: name,
      seedTrack: seedTrack || null,
      sourceBackedArtist: Boolean(sourceBackedArtist),
    },
    {
      priority,
      taskKey: `artist_profile:${deepNormalize(name)}:${dayBucket()}`,
      reviveDone: Boolean(sourceBackedArtist),
    }
  );
}

async function seedTracks(tracks, priority, context = {}) {
  const items = tracks || [];
  const concurrency = 4;
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    await Promise.all(batch.map(async sourceTrack => {
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
      await deepCatalog.seedTrackTasks(track, {
        priority,
        preferBulk: Boolean(context.preferBulk),
      });
    }));
  }
}

function uniqueTracks(tracks = []) {
  const seen = new Set();
  const out = [];
  for (const track of tracks || []) {
    const key = `${deepNormalize(track.artist)}|${deepNormalize(track.title)}`;
    if (!key || key === '|' || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

async function enqueueArtistBulkTasks(artist, seedTrack, {
  topTracks = [],
  recentTracks = [],
  skipTopHq = false,
} = {}) {
  const artistKey = deepNormalize(artist);
  const bucket = dayBucket();

  const plan = async (tracks, mode, quality, taskPriority, fallbackPriority, skip = false) => {
    if (skip || !tracks?.length) return { skipped: true, missing: 0 };

    const missing = await deepCatalog.missingMediaTracks(tracks, quality);
    if (!missing.length) return { complete: true, missing: 0 };

    if (!shouldUseBulk(tracks.length, missing.length)) {
      await enqueueSparseMediaFallback(missing, quality, fallbackPriority);
      return { sparse: true, missing: missing.length };
    }

    await deepCatalog.enqueueTask(
      'artist_bulk_media',
      { artist, seedTrack, mode, quality },
      {
        priority: taskPriority,
        taskKey: `artist_bulk:${mode}:${quality}:${artistKey}:${bucket}`,
      }
    );
    return { bulk: true, missing: missing.length };
  };

  return {
    recentHq: await plan(recentTracks, 'recent', 'hq', 122, 114),
    topHq: await plan(topTracks, 'top', 'hq', 120, 114, skipTopHq),
    recentNormal: await plan(recentTracks, 'recent', 'normal', 76, 72),
    topNormal: await plan(topTracks, 'top', 'normal', 74, 72),
  };
}

function pairBridgedMedia(matches, received = []) {
  const unused = (received || []).map((media, index) => ({ media, index, used: false }));
  const pairs = [];
  const allowPositionalFallback = matches.length === received.length;

  for (const match of matches || []) {
    const track = match.track || {};
    const nt = deepNormalize(track.title);
    const na = deepNormalize(track.artist);
    let best = null;
    let bestScore = -1;

    for (const item of unused) {
      if (item.used) continue;
      const mt = deepNormalize(item.media?.title || item.media?.fileName || '');
      const ma = deepNormalize(item.media?.performer || '');
      let score = 0;
      if (nt && mt === nt) score += 8;
      else if (nt && mt && (mt.includes(nt) || nt.includes(mt))) score += 5;
      if (na && ma === na) score += 4;
      else if (na && ma && (ma.includes(na) || na.includes(ma))) score += 2;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }

    if (!best || bestScore < 5) {
      best = allowPositionalFallback
        ? (unused.find(item => !item.used) || null)
        : null;
    }
    if (!best) continue;

    best.used = true;
    pairs.push({ track, media: best.media });
  }

  return pairs;
}

async function canonicalTrackForPersistence(track, timeoutMs = 4000) {
  if (!track?.artistInferred) return track;
  if (track?.source !== 'melobot' || !track?.rawText) {
    throw new Error('Primary artist identity is inferred and cannot be persisted.');
  }

  const resolved = await resolveMeloBotTrackCandidate(
    tg,
    track,
    { timeoutMs, forceIdentity: true }
  );
  if (!resolved?.artist || !resolved?.title || resolved.artistInferred) {
    throw new Error('Primary artist identity is still inferred.');
  }
  return { ...track, ...resolved, source: 'melobot', artistInferred: false };
}

async function cacheBulkMedia(tracks, bulk, quality, label) {
  const sourceTracks = uniqueTracks(tracks);
  const matches = matchBulkAudioToTracks(sourceTracks, bulk?.audioItems || []);
  if (!matches.length) return { cached: 0, matched: 0, expected: sourceTracks.length };

  let bridged;
  try {
    bridged = await captureForwardedMediaBatch(matches.map(item => item.audioItem.message));
  } catch (err) {
    console.warn(`[${label} batch bridge]`, err.message);
    return { cached: 0, matched: matches.length, expected: sourceTracks.length, bridgeError: err.message };
  }

  let cached = 0;
  const received = bridged.items || [];
  const pairs = pairBridgedMedia(matches, received);
  for (const pair of pairs) {
    const track = { ...pair.track, source: 'melobot' };
    const media = pair.media;
    const performer = clean(media?.performer || '');
    const durableTrack = track.artistInferred && performer
      ? { ...track, artist: performer, artistInferred: false }
      : track;

    if (durableTrack.artistInferred) {
      console.warn(
        `[${label} cache skipped]`,
        durableTrack.title,
        'primary artist is still inferred'
      );
      continue;
    }

    try {
      await deepCatalog.setMedia(durableTrack, quality, media, {
        source: 'melobot',
        satisfiedBy: label,
      });
      if (quality === 'hq') {
        await cache.set(durableTrack, media, { sourceFetch: true });
      }
      cached += 1;
    } catch (err) {
      console.warn(
        `[${label} cache]`,
        durableTrack.artist,
        durableTrack.title,
        err.message
      );
    }
  }

  return {
    cached,
    matched: matches.length,
    expected: sourceTracks.length,
    bridgeComplete: Boolean(bridged.complete),
    forwarded: received.length,
    paired: pairs.length,
  };
}

async function enqueueSparseMediaFallback(tracks, quality, priority = 104) {
  for (const track of tracks || []) {
    const trackKey = deepTrackKey(track);
    if (!trackKey || trackKey === '|') continue;
    await deepCatalog.enqueueTask(
      quality === 'hq' ? 'track_hq' : 'track_normal',
      { track: { ...track, trackKey }, trackKey },
      {
        priority,
        taskKey: `track_${quality}:${trackKey}`,
        reviveDone: true,
      }
    );
  }
}

function shouldUseBulk(total, missing) {
  const count = Math.max(0, Number(missing || 0));
  const all = Math.max(0, Number(total || 0));
  if (!count || !all) return false;
  if (count <= 2) return false;
  return count / all >= 0.35;
}

async function runArtistBulkMedia(task) {
  const { artist, seedTrack = null, mode = 'top', quality = 'hq' } = task.payload || {};
  if (!artist) throw new Error('Artist bulk task is missing artist.');

  const storedTracks = await deepCatalog.getArtistList(artist, mode, 20);
  const missing = await deepCatalog.missingMediaTracks(storedTracks, quality);
  if (!missing.length) {
    return { artist, mode, quality, cached: 0, skipped: 'already_complete' };
  }
  if (!shouldUseBulk(storedTracks.length, missing.length)) {
    await enqueueSparseMediaFallback(missing, quality, quality === 'hq' ? 114 : 72);
    return {
      artist,
      mode,
      quality,
      cached: 0,
      missingBefore: missing.length,
      skipped: 'sparse_holes_deferred_to_individual',
    };
  }

  const context = mode === 'recent'
    ? await prepareMeloBotBulkRecentTracks(tg, artist, seedTrack)
    : await prepareMeloBotBulkTopTracks(tg, artist, seedTrack);

  const tracks = mode === 'recent'
    ? (context.recentTracks || context.tracks || storedTracks)
    : (context.topTracks || context.tracks || storedTracks);

  const button = quality === 'hq'
    ? (mode === 'recent' ? context.recentBulkHighButton : context.bulkHighButton)
    : (mode === 'recent' ? context.recentBulkNormalButton : context.bulkNormalButton);

  if (!button) {
    await enqueueSparseMediaFallback(missing, quality, quality === 'hq' ? 114 : 72);
    return {
      artist,
      mode,
      quality,
      cached: 0,
      missingBefore: missing.length,
      skipped: 'bulk_button_missing_deferred_to_individual',
    };
  }

  const bulk = await downloadMeloBotBulkTracks(tg, {
    button,
    label: `${artist} ${mode} ${quality}`,
    expectedCount: tracks.length,
    timeoutMs: 25_000,
  });

  const saved = await cacheBulkMedia(tracks, bulk, quality, `artist_bulk_${mode}_${quality}`);
  return {
    artist,
    mode,
    quality,
    missingBefore: missing.length,
    ...saved,
  };
}

async function runAlbumBulkMedia(task) {
  const { artist, albumTitle, seedTrack = null, quality = 'hq' } = task.payload || {};
  if (!artist || !albumTitle) throw new Error('Album bulk task is incomplete.');

  const context = await prepareMeloBotBulkAlbum(tg, artist, albumTitle, seedTrack);
  const missing = await deepCatalog.missingMediaTracks(context.tracks, quality);
  if (!missing.length) {
    return { artist, album: albumTitle, quality, cached: 0, skipped: 'already_complete' };
  }
  if (!shouldUseBulk(context.tracks.length, missing.length)) {
    await enqueueSparseMediaFallback(missing, quality, quality === 'hq' ? 110 : 70);
    return {
      artist,
      album: albumTitle,
      quality,
      cached: 0,
      missingBefore: missing.length,
      skipped: 'sparse_holes_deferred_to_individual',
    };
  }

  const button = quality === 'hq' ? context.bulkHighButton : context.bulkNormalButton;
  if (!button) {
    await enqueueSparseMediaFallback(missing, quality, quality === 'hq' ? 110 : 70);
    return {
      artist,
      album: albumTitle,
      quality,
      cached: 0,
      missingBefore: missing.length,
      skipped: 'bulk_button_missing_deferred_to_individual',
    };
  }

  const bulk = await downloadMeloBotBulkTracks(tg, {
    button,
    label: `album ${albumTitle} ${quality}`,
    expectedCount: context.tracks.length,
    timeoutMs: 25_000,
  });
  const saved = await cacheBulkMedia(context.tracks, bulk, quality, `album_bulk_${quality}`);
  return {
    artist,
    album: albumTitle,
    quality,
    missingBefore: missing.length,
    ...saved,
  };
}

async function runTrackEnrich(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Track enrichment task has no live MeloBot track reference.');

  const canonicalTrack = await canonicalTrackForPersistence(track, 2500);
  const bundle = await enrichMeloBotTrack(
    tg,
    canonicalTrack,
    { timeoutMs: 8000 }
  );
  const liveTrack = {
    ...canonicalTrack,
    ...(bundle.candidate || {}),
    source: 'melobot',
    artistInferred: false,
  };
  const summary = {
    track: `${liveTrack.artist} — ${liveTrack.title}`,
    metadata: false,
    cover: false,
    lyrics: false,
    errors: [...(bundle.errors || [])],
  };

  if (bundle.capabilities) {
    try { await deepCatalog.setCapabilities(liveTrack, bundle.capabilities); } catch {}
  }

  if (bundle.metadata) {
    const meaningfulMetadata = Boolean(
      bundle.metadata.releaseDate
      || bundle.metadata.releaseDateRaw
      || bundle.metadata.popularityCount
      || bundle.metadata.popularityText
      || String(bundle.metadata.raw || '').trim()
    );
    if (meaningfulMetadata) {
      try {
        await deepCatalog.setMetadata(liveTrack, bundle.metadata);
        summary.metadata = true;
        summary.releaseDate = bundle.metadata.releaseDate || bundle.metadata.releaseDateRaw || null;
        summary.popularity = bundle.metadata.popularityCount || bundle.metadata.popularityText || null;
      } catch (err) {
        summary.errors.push(`metadata-save: ${err.message}`);
      }
    }
  }

  if (bundle.cover?.photoMessage) {
    try {
      const media = await captureForwardedMedia(bundle.cover.photoMessage);
      if (media.kind === 'photo') {
        await deepCatalog.setCover(liveTrack, media);
        summary.cover = true;
      }
    } catch (err) {
      summary.errors.push(`cover-save: ${err.message}`);
    }
  }

  if (bundle.lyrics?.available && bundle.lyrics.text) {
    try {
      await deepCatalog.setLyrics(liveTrack, bundle.lyrics.text, 'melobot');
      summary.lyrics = true;
      summary.lyricsChars = bundle.lyrics.text.length;
    } catch (err) {
      summary.errors.push(`lyrics-save: ${err.message}`);
    }
  } else if (bundle.lyrics?.checked === true) {
    try { await deepCatalog.markNoLyrics(liveTrack, 'melobot'); } catch {}
  }

  const unresolvedPositiveCapabilities = [];
  if (bundle.capabilities?.hasMetadata && !summary.metadata) {
    unresolvedPositiveCapabilities.push('metadata');
  }
  if (bundle.capabilities?.hasCover && !summary.cover) {
    unresolvedPositiveCapabilities.push('cover');
  }
  if (
    bundle.capabilities?.hasLyrics
    && !summary.lyrics
    && bundle.lyrics?.checked !== true
  ) {
    unresolvedPositiveCapabilities.push('lyrics');
  }

  if (unresolvedPositiveCapabilities.length) {
    summary.errors.push(
      `unresolved capabilities: ${unresolvedPositiveCapabilities.join(', ')}`
    );
  }

  if (
    unresolvedPositiveCapabilities.length
    || (!summary.metadata && !summary.cover && !summary.lyrics && summary.errors.length)
  ) {
    throw new Error(`Track enrichment failed: ${summary.errors.join(' | ')}`);
  }
  return summary;
}

async function runHomeDiscovery(task) {
  const maxSections = Math.max(1, Number(task.payload?.maxSections || 8));
  const discovered = await discoverMeloBotHome(tg, { maxSections });
  await seedTracks(discovered.tracks, 78, {
    discoveredFrom: 'home_discovery',
    preferBulk: true,
  });

  const byArtist = new Map();
  for (const track of discovered.tracks || []) {
    const key = deepNormalize(track.artist);
    if (key && !byArtist.has(key)) byArtist.set(key, track);
  }
  for (const artistName of discovered.artists || []) {
    const key = deepNormalize(artistName);
    if (!key) continue;
    await enqueueArtistProfile(artistName, byArtist.get(key) || null, 84);
  }

  return {
    sections: discovered.sections?.length || 0,
    tracks: discovered.tracks?.length || 0,
    artists: discovered.artists?.length || 0,
  };
}

async function runPlaylistDiscovery(task) {
  const maxPlaylists = Math.max(1, Number(task.payload?.maxPlaylists || 6));
  const discovered = await discoverMeloBotPlaylists(tg, { maxPlaylists });

  await seedTracks(discovered.tracks, 86, {
    discoveredFrom: 'playlist_discovery',
    preferBulk: true,
  });

  await Promise.all((discovered.entries || []).map(entry =>
    catalog.recordSearch(
      `browse:playlist:${entry.playlist.key}`,
      entry.tracks || []
    ).catch(err => console.warn('[playlist browse cache]', entry.playlist.label, err.message))
  ));

  const byArtist = new Map();
  for (const track of discovered.tracks || []) {
    const key = deepNormalize(track.artist);
    if (key && !byArtist.has(key)) byArtist.set(key, track);
  }

  await Promise.all([...byArtist.values()].map(track =>
    enqueueArtistProfile(track.artist, track, 96)
  ));

  return {
    playlists: discovered.playlists?.length || 0,
    tracks: discovered.tracks?.length || 0,
    artists: discovered.artists?.length || byArtist.size,
  };
}

async function runFeed(task) {
  const { feed, origin = 'unknown' } = task.payload || {};
  if (!feed) throw new Error('Feed task is missing feed name.');

  const result = await discoverMeloBotFeed(tg, feed, { contentOrigin: origin });
  try { await catalog.recordSearch(`browse:${feed}`, result.tracks); } catch (err) {
    console.warn('[feed browse cache]', feed, err.message);
  }
  await seedTracks(result.tracks, feed === '/new' ? 108 : 96, {
    discoveredFrom: `feed:${feed}`,
    feed,
    contentOrigin: origin,
    preferBulk: true,
  });

  const artistMap = new Map();
  for (const track of result.tracks || []) {
    const key = deepNormalize(track.artist);
    if (key && !artistMap.has(key)) artistMap.set(key, track);
  }

  for (const track of artistMap.values()) {
    await enqueueArtistProfile(track.artist, track, feed === '/new' ? 125 : 115);
  }

  return { feed, tracks: result.tracks.length, artists: artistMap.size };
}

async function runArtistProfile(task) {
  const {
    artist,
    seedTrack = null,
    sourceBackedArtist = false,
  } = task.payload || {};
  if (!artist) throw new Error('Artist profile task is missing artist.');

  // Feed and playlist track rows often carry collaboration credits rather
  // than a real Artist-page identity. Legacy queued tasks such as
  // "Drake & Yeat" used to spend several seconds probing a profile that does
  // not exist, then sometimes persisted a tiny search-derived pseudo-profile.
  // Skip those ambiguous background tasks before touching the serialized
  // MeloBot lane. A name observed directly on an Artist picker is explicitly
  // marked source-backed and is still allowed through.
  if (!sourceBackedArtist && hasCompositeArtistSeparators(artist)) {
    console.log('[deep crawler] skipped composite artist credit', artist);
    return { artist, skipped: 'composite_artist_credit' };
  }

  const live = await openMeloBotArtistFresh(
    tg,
    artist,
    seedTrack,
    { timeoutMs: 3000 }
  );
  const recent = live.recentTracks || [];
  const top = live.topTracks || live.tracks || [];

  await catalog.recordArtist(live.artist, {
    topTracks: top,
    recentTracks: recent,
    albumButton: live.albumButton || null,
  });

  await deepCatalog.setArtistList(live.artist, 'recent', recent);
  await deepCatalog.setArtistList(live.artist, 'top', top);

  // Prefer one native MeloBot bulk click over ten individual media tasks.
  await seedTracks(recent, 104, {
    discoveredFrom: `artist_recent:${live.artist}`,
    preferBulk: true,
  });
  await seedTracks(top, 100, {
    discoveredFrom: `artist_top:${live.artist}`,
    preferBulk: true,
  });

  const bulkSeed = seedTrack || recent[0] || top[0] || null;

  // Keep profile discovery short. Media warming is intentionally split into
  // separate heavy tasks so an artist-profile crawl cannot hold the user queue
  // for tens of seconds.
  await enqueueArtistBulkTasks(live.artist, bulkSeed, {
    topTracks: top,
    recentTracks: recent,
    skipTopHq: false,
  });

  for (const related of live.relatedArtists || []) {
    if (deepNormalize(related) !== deepNormalize(live.artist)) {
      await enqueueArtistProfile(related, null, 82, { sourceBackedArtist: true });
    }
  }

  const hasAlbumSurface = Boolean(
    live.albumButton
    || (live.albumListingConfirmed && (live.albumList?.length || live.albumListingConfirmedEmpty))
  );
  if (hasAlbumSurface) {
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
    hasAlbums: Boolean(live.albumList?.length),
    albumListingConfirmed: Boolean(live.albumListingConfirmed),
  };
}

async function runAlbumIndex(task) {
  const { artist, seedTrack = null } = task.payload || {};
  if (!artist) throw new Error('Album index task is missing artist.');

  const resolved = await resolveMeloBotArtistAlbums(
    tg,
    artist,
    seedTrack,
    { allowEmpty: true, timeoutMs: 3500 }
  );
  const albums = resolved.albums;

  if (resolved.complete) {
    await catalog.recordAlbums(resolved.artist, albums, {
      emptyConfirmed: Boolean(resolved.confirmedEmpty),
    });
  } else {
    await catalog.mergeAlbums(resolved.artist, albums);
  }

  if (!albums.length) {
    return {
      artist: resolved.artist,
      albums: 0,
      confirmedEmpty: Boolean(resolved.confirmedEmpty && resolved.complete),
    };
  }

  await Promise.all(albums.map(async album => {
    await deepCatalog.upsertAlbum(resolved.artist, album);
    await deepCatalog.enqueueTask(
      'album_detail',
      {
        artist: resolved.artist,
        album,
        seedTrack: resolved.seed || seedTrack || null,
      },
      {
        priority: 76,
        taskKey: `album_detail:${deepNormalize(resolved.artist)}:${deepNormalize(album.title)}:${albumRefreshBucket()}`,
      }
    );
  }));

  return { artist: resolved.artist, albums: albums.length };
}

async function runAlbumDetail(task) {
  const { artist, album, seedTrack = null } = task.payload || {};
  if (!artist || !album?.title) throw new Error('Album detail task is incomplete.');

  const resolved = await resolveMeloBotArtistAlbumsDirectFirst(
    tg,
    artist,
    seedTrack,
    {
      allowEmpty: true,
      maxAlbums: 40,
      directTimeoutMs: 3500,
    }
  );
  const albums = resolved.albums;
  const target = albums.find(item =>
    deepNormalize(item.title) === deepNormalize(album.title)
  ) || album;
  const albumContext = await openMeloBotAlbumRobustByTitle(
    tg,
    resolved.artist,
    target.title,
    {
      album: target,
      timeoutMs: 3500,
      maxPages: 8,
    }
  );
  const tracks = albumContext.tracks;

  if (resolved.complete) {
    await catalog.recordAlbums(resolved.artist, albums, {
      emptyConfirmed: Boolean(resolved.confirmedEmpty),
    });
  } else {
    await catalog.mergeAlbums(resolved.artist, albums);
  }
  await catalog.recordAlbumTracks(resolved.artist, target, tracks);
  await deepCatalog.setAlbumTracks(resolved.artist, target, tracks);
  await seedTracks(tracks, 84, {
    discoveredFrom: `album:${target.title}`,
    album: target.title,
    preferBulk: true,
  });

  const albumSeed = albumContext.seed || resolved.seed || seedTrack || tracks[0] || null;
  const albumKey = `${deepNormalize(resolved.artist)}:${deepNormalize(target.title)}`;

  // Album detail stays metadata-only on the interactive source lane. Heavy
  // media warming is queued separately and only runs after a longer idle window.
  const missingHq = await deepCatalog.missingMediaTracks(tracks, 'hq');
  const albumHqComplete = missingHq.length === 0;

  if (!albumHqComplete) {
    if (shouldUseBulk(tracks.length, missingHq.length)) {
      await deepCatalog.enqueueTask(
        'album_bulk_media',
        { artist: resolved.artist, albumTitle: target.title, seedTrack: albumSeed, quality: 'hq' },
        { priority: 92, taskKey: `album_bulk:hq:${albumKey}`, reviveDone: true }
      );
    } else if (missingHq.length) {
      await enqueueSparseMediaFallback(missingHq, 'hq', 110);
    }
  }

  const missingNormal = await deepCatalog.missingMediaTracks(tracks, 'normal');
  if (shouldUseBulk(tracks.length, missingNormal.length)) {
    await deepCatalog.enqueueTask(
      'album_bulk_media',
      { artist: resolved.artist, albumTitle: target.title, seedTrack: albumSeed, quality: 'normal' },
      { priority: 68, taskKey: `album_bulk:normal:${albumKey}`, reviveDone: true }
    );
  } else if (missingNormal.length) {
    await enqueueSparseMediaFallback(missingNormal, 'normal', 70);
  }

  return {
    artist: resolved.artist,
    album: target.title,
    tracks: tracks.length,
    hqComplete: albumHqComplete,
  };
}

async function runTrackHq(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('HQ task has no live MeloBot track reference.');

  const liveTrack = await canonicalTrackForPersistence(track, 2500);
  const result = await downloadMeloBotTrackQuality(
    tg,
    liveTrack,
    'hq',
    {
      timeoutMs: 4500,
      menuTimeoutMs: 2500,
      deliveryTimeoutMs: 3000,
    }
  );
  const media = await captureForwardedMedia(result.audioMessage);
  await deepCatalog.setMedia(liveTrack, 'hq', media, { source: 'melobot' });

  // HQ is also the default Navazon delivery cache.
  await cache.set(liveTrack, media, { sourceFetch: true });

  return { track: `${liveTrack.artist} — ${liveTrack.title}`, quality: 'hq', cached: true };
}

async function runTrackNormal(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Normal-quality task has no live MeloBot track reference.');

  const liveTrack = await canonicalTrackForPersistence(track, 2500);
  const result = await downloadMeloBotTrackQuality(
    tg,
    liveTrack,
    'normal',
    {
      timeoutMs: 4500,
      menuTimeoutMs: 2500,
      deliveryTimeoutMs: 3000,
    }
  );
  const media = await captureForwardedMedia(result.audioMessage);
  await deepCatalog.setMedia(liveTrack, 'normal', media, { source: 'melobot' });

  return { track: `${liveTrack.artist} — ${liveTrack.title}`, quality: 'normal', cached: true };
}

async function runTrackMetadata(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Metadata task has no live MeloBot track reference.');

  const liveTrack = await canonicalTrackForPersistence(track, 2500);
  const metadata = await getMeloBotTrackMetadata(
    tg,
    liveTrack,
    { timeoutMs: 4000 }
  );
  await deepCatalog.setMetadata(liveTrack, metadata);
  return {
    track: `${liveTrack.artist} — ${liveTrack.title}`,
    releaseDate: metadata.releaseDate || metadata.releaseDateRaw || null,
    popularity: metadata.popularityCount || metadata.popularityText || null,
  };
}

async function runTrackCover(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Cover task has no live MeloBot track reference.');

  const liveTrack = await canonicalTrackForPersistence(track, 2500);
  const cover = await getMeloBotCover(
    tg,
    liveTrack,
    { timeoutMs: 4000 }
  );
  if (!cover?.photoMessage) {
    return { track: `${liveTrack.artist} — ${liveTrack.title}`, cover: false };
  }

  const media = await captureForwardedMedia(cover.photoMessage);
  if (media.kind !== 'photo') throw new Error(`Expected photo cover, received ${media.kind}.`);
  await deepCatalog.setCover(liveTrack, media);
  return { track: `${liveTrack.artist} — ${liveTrack.title}`, cover: true };
}

async function runTrackLyrics(task) {
  const track = task.payload?.track;
  if (!track?.rawText) throw new Error('Lyrics task has no live MeloBot track reference.');

  const liveTrack = await canonicalTrackForPersistence(track, 2500);
  const lyrics = await getMeloBotLyrics(
    tg,
    liveTrack,
    { timeoutMs: 4000 }
  );
  if (lyrics.available && lyrics.text) {
    await deepCatalog.setLyrics(liveTrack, lyrics.text, 'melobot');
    return {
      track: `${liveTrack.artist} — ${liveTrack.title}`,
      lyrics: true,
      chars: lyrics.text.length,
    };
  }

  if (lyrics.checked === true) {
    await deepCatalog.markNoLyrics(liveTrack, 'melobot');
    return { track: `${liveTrack.artist} — ${liveTrack.title}`, lyrics: false };
  }

  throw new Error('Lyrics availability could not be confirmed.');
}

export async function executeDeepTask(task) {
  const label = task?.kind || 'unknown';
  const runId = await recordCrawlerStart(`deep:${label}`);

  try {
    let summary;
    if (task.kind === 'feed') summary = await runFeed(task);
    else if (task.kind === 'home_discovery') summary = await runHomeDiscovery(task);
    else if (task.kind === 'playlist_discovery') summary = await runPlaylistDiscovery(task);
    else if (task.kind === 'artist_profile') summary = await runArtistProfile(task);
    else if (task.kind === 'artist_bulk_media') summary = await runArtistBulkMedia(task);
    else if (task.kind === 'album_bulk_media') summary = await runAlbumBulkMedia(task);
    else if (task.kind === 'track_enrich') summary = await runTrackEnrich(task);
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
    const noPointRetrying = /button not found|no live MeloBot track reference|Expected photo cover|artist page returned no usable tracks/i.test(err.message || '');
    await deepCatalog.failTask(task.id, err.message, {
      retryDelayMs: noPointRetrying ? 24 * 60 * 60 * 1000 : config.discoveryRetryDelayMs,
      maxAttempts: noPointRetrying ? 2 : 4,
    });
    await recordCrawlerFinish(runId, { ok: false, error: err.message, summary: { kind: task.kind } });
    console.warn(`[deep crawler] failed ${task.kind}`, err.message);
    throw err;
  }
}
