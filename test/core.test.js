import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOT_TOKEN ||= 'test-token';
process.env.BOT_USERNAME ||= 'Navazonbot';
process.env.TG_API_ID ||= '12345';
process.env.TG_API_HASH ||= 'test-hash';
process.env.TG_STRING_SESSION ||= 'test-session';
process.env.PROXY_USER_ID ||= '123456';
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/navazon';
process.env.WEBHOOK_SECRET ||= 'test-webhook';
process.env.CRAWLER_TOKEN ||= 'test-crawler';
process.env.ADMIN_TOKEN ||= 'test-admin';

const {
  parseTrackButton,
  parseAlbumButton,
  inspectMeloBotAlbumListing,
  albumQueryMatches,
  resolveMeloBotArtistAlbums,
  matchBulkAudioToTracks,
} = await import('../src/sources/melobot.js');
const { parseAhangifyResults } = await import('../src/ahangify.js');
const { trackCacheKey } = await import('../src/cache.js');
const {
  resultsKeyboard,
  albumTracksKeyboard,
  noAlbumsKeyboard,
  albumsErrorKeyboard,
  homeKeyboard,
  curatedPlaylistsKeyboard,
} = await import('../src/ui.js');
const { CURATED_PLAYLISTS, HOME_FEEDS } = await import('../src/homeCatalog.js');

test('MeloBot parser extracts artist, title and popularity', () => {
  const track = parseTrackButton('🎵 Shadmehr, Taghdir x 1.6M');
  assert.equal(track.artist, 'Shadmehr');
  assert.equal(track.title, 'Taghdir');
  assert.equal(track.sourcePopularityCount, 1_600_000);
});

test('MeloBot parser rejects navigation controls', () => {
  assert.equal(parseTrackButton('بعدی'), null);
  assert.equal(parseTrackButton('صفحه بعد'), null);
});

test('bulk matching does not shift tracks when a partial response misses one', () => {
  const tracks = [
    { artist: 'A', title: 'One' },
    { artist: 'A', title: 'Two' },
    { artist: 'A', title: 'Three' },
  ];
  const audio = [
    { performer: 'A', title: 'One' },
    { performer: 'A', title: 'Three' },
  ];
  const matches = matchBulkAudioToTracks(tracks, audio);
  assert.deepEqual(matches.map(item => item.track.title), ['One', 'Three']);
});

test('Ahangify parser keeps rank 1 first and extracts download command', () => {
  const messages = [{
    message: [
      '🎯 2. Artist - Second',
      '🕒 03:20',
      '💾 8 MB',
      '📀 320',
      '/dl_second',
      '',
      '🎯 1. Artist - First',
      '🕒 03:10',
      '💾 7 MB',
      '📀 320',
      '/dl_first',
    ].join('\n'),
  }];
  const results = parseAhangifyResults(messages);
  assert.equal(results[0].rank, 1);
  assert.equal(results[0].cmd, '/dl_first');
  assert.equal(results[1].rank, 2);
});

test('cache key ignores changing MeloBot popularity suffix', () => {
  const first = trackCacheKey({
    artist: 'Shadmehr',
    title: 'Taghdir',
    rawText: '🎵 Shadmehr, Taghdir x 1.2M',
  });
  const later = trackCacheKey({
    artist: 'Shadmehr',
    title: 'Taghdir',
    rawText: '🎵 Shadmehr, Taghdir x 1.7M',
  });
  assert.equal(first, later);
});

test('artist shortcut callback points at the dominant artist result', () => {
  const session = {
    options: [
      { source: 'melobot', artist: 'Other', title: 'X' },
      { source: 'melobot', artist: 'Shadmehr', title: 'A' },
      { source: 'melobot', artist: 'Shadmehr', title: 'B' },
    ],
  };
  const keyboard = resultsKeyboard('abc123', session);
  const artistButton = keyboard.inline_keyboard.at(-1)[0];
  assert.equal(artistButton.callback_data, 'ar:abc123:1');
});


test('album tracklists paginate without hiding later songs', () => {
  const tracks = Array.from({ length: 12 }, (_, index) => ({
    artist: 'Artist',
    title: `Track ${index + 1}`,
  }));

  const first = albumTracksKeyboard('sess', tracks, 0, 0);
  const firstCallbacks = first.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(firstCallbacks.includes('apg:sess:1'));

  const second = albumTracksKeyboard('sess', tracks, 0, 1);
  assert.equal(second.inline_keyboard[0][0].callback_data, 'alt:sess:10');
});


test('MeloBot parser also accepts dash-separated search labels', () => {
  const track = parseTrackButton('🎵 Shadmehr - Taghdir');
  assert.equal(track.artist, 'Shadmehr');
  assert.equal(track.title, 'Taghdir');
});


test('search results can include album rows', () => {
  const session = {
    options: [{ source: 'melobot', artist: 'Shadmehr', title: 'Track', rawText: 'x' }],
    albumOptions: [{ artist: 'Shadmehr', title: 'Taghdir', trackCount: 8 }],
  };
  const keyboard = resultsKeyboard('sess', session);
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(callbacks.includes('sal:sess:0'));
});

test('artist page always exposes Albums', async () => {
  const { artistHomeKeyboard } = await import('../src/ui.js');
  const keyboard = artistHomeKeyboard('sess', { artist: 'Shadmehr', tracks: [] }, false);
  const labels = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.ok(labels.includes('💿 آلبوم‌ها'));
});

test('search-opened album returns to search results', () => {
  const tracks = [{ artist: 'A', title: 'One' }];
  const keyboard = albumTracksKeyboard('sess', tracks, 0, 0, { backAction: 'results' });
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(callbacks.includes('rs:sess'));
});


test('no-albums page returns to the artist page', () => {
  const keyboard = noAlbumsKeyboard('sess');
  assert.equal(keyboard.inline_keyboard[0][0].text, '🔙 صفحه‌ی خواننده');
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'arh:sess');
});


test('home exposes only the four primary discovery actions', () => {
  const keyboard = homeKeyboard('sess');
  const labels = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.deepEqual(labels, [
    '🔥 جدیدترین‌ها',
    '📥 پردانلودترین‌ها',
    '🎧 پلی‌لیست‌ها',
    '🔔 دنبال‌شده‌ها',
  ]);
});

test('curated playlists intentionally exclude noisy seasonal items such as Ghadr', () => {
  assert.equal(CURATED_PLAYLISTS.some(item => /قدر/u.test(item.label)), false);
  assert.ok(CURATED_PLAYLISTS.some(item => item.key === 'pop'));
  assert.ok(CURATED_PLAYLISTS.some(item => item.key === 'remix'));

  const keyboard = curatedPlaylistsKeyboard('sess');
  const labels = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.equal(labels.some(label => /قدر/u.test(label)), false);
});

test('home feed shortcuts map to the stable MeloBot commands', () => {
  assert.equal(HOME_FEEDS.ir.command, '/new');
  assert.equal(HOME_FEEDS.foreign.command, '/foreign');
  assert.equal(HOME_FEEDS.tr.command, '/turkish');
  assert.equal(HOME_FEEDS.ar.command, '/arabic');
  assert.equal(HOME_FEEDS.day.command, '/topday');
  assert.equal(HOME_FEEDS.week.command, '/topweek');
});


test('MeloBot album-list page is detected without treating an album as navigation', () => {
  const messages = [{
    message: 'آلبوم های خواننده (10) :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: '💿 In Roozha (8)' }] },
        { buttons: [{ text: '💿 Shahre Divooneh (3)' }] },
        { buttons: [{ text: '💿 Yek Khatereh Az Farda (12)' }] },
      ],
    },
  }];

  const listing = inspectMeloBotAlbumListing(messages);
  assert.equal(listing.confirmed, true);
  assert.equal(listing.confirmedEmpty, false);
  assert.equal(listing.declaredCount, 10);
  assert.deepEqual(listing.albums.map(album => album.title), [
    'In Roozha',
    'Shahre Divooneh',
    'Yek Khatereh Az Farda',
  ]);
  assert.equal(parseAlbumButton('💿 In Roozha (8)').trackCount, 8);
});

test('album + artist query matches every album by that artist', () => {
  assert.equal(
    albumQueryMatches('آلبوم Ehsan Khajeamiri', 'Ehsan Khajeamiri', 'In Roozha'),
    true
  );
  assert.equal(
    albumQueryMatches('album Ehsan Khajeamiri', 'Ehsan Khajeamiri', 'Paeiz Tanhaei'),
    true
  );
});

test('specific album query still filters by album title', () => {
  assert.equal(
    albumQueryMatches(
      'Ehsan Khajeamiri In Roozha',
      'Ehsan Khajeamiri',
      'In Roozha'
    ),
    true
  );
  assert.equal(
    albumQueryMatches(
      'Ehsan Khajeamiri In Roozha',
      'Ehsan Khajeamiri',
      'Paeiz Tanhaei'
    ),
    false
  );
});

test('explicit album searches render albums before track rows', () => {
  const session = {
    albumFirst: true,
    options: [{ source: 'melobot', artist: 'Ehsan', title: 'Track', rawText: 'x' }],
    albumOptions: [{ artist: 'Ehsan', title: 'In Roozha', trackCount: 8 }],
  };
  const keyboard = resultsKeyboard('sess', session);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'sal:sess:0');
});


test('album listing recognizes Persian digits and confirmed zero safely', () => {
  const nonEmpty = inspectMeloBotAlbumListing([{
    message: 'آلبوم‌های خواننده (۲) :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: '💿 Album One (۸)' }] },
        { buttons: [{ text: '💿 Album Two (۳)' }] },
      ],
    },
  }]);
  assert.equal(nonEmpty.declaredCount, 2);
  assert.equal(nonEmpty.complete, true);
  assert.equal(nonEmpty.albums[0].trackCount, 8);

  const empty = inspectMeloBotAlbumListing([{
    message: 'آلبوم های خواننده (۰) :',
    replyMarkup: { rows: [] },
  }]);
  assert.equal(empty.confirmed, true);
  assert.equal(empty.confirmedEmpty, true);
  assert.equal(empty.complete, true);
});

test('declared album count prevents partial listings from being marked complete', () => {
  const listing = inspectMeloBotAlbumListing([{
    message: 'آلبوم های خواننده (10) :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: '💿 In Roozha (8)' }] },
        { buttons: [{ text: '💿 Shahre Divooneh (3)' }] },
      ],
    },
  }]);
  assert.equal(listing.confirmed, true);
  assert.equal(listing.complete, false);
});

test('specific explicit album search filters the requested title once artist is known', () => {
  const albums = [
    { title: 'In Roozha' },
    { title: 'Paeiz Tanhaei' },
  ];
  const matches = albums.filter(album =>
    albumQueryMatches(
      'album Ehsan Khajeamiri In Roozha',
      'Ehsan Khajeamiri',
      album.title
    )
  );
  assert.deepEqual(matches.map(album => album.title), ['In Roozha']);
});


test('Persian album intent variants are treated as album searches', () => {
  assert.equal(
    albumQueryMatches('آلبوم‌های Ehsan Khajeamiri', 'Ehsan Khajeamiri', 'In Roozha'),
    true
  );
  assert.equal(
    albumQueryMatches('البوم Ehsan Khajeamiri', 'Ehsan Khajeamiri', 'Paeiz Tanhaei'),
    true
  );
});


test('album source failures stay recoverable instead of silently returning to artist', () => {
  const keyboard = albumsErrorKeyboard('sess', 2);
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons[0].callback_data, 'alb:sess:2');
  assert.equal(buttons[1].callback_data, 'arh:sess');
});


test('state-safe artist album resolver is exported for all album flows', () => {
  assert.equal(typeof resolveMeloBotArtistAlbums, 'function');
});
