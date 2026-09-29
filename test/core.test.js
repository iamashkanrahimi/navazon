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
process.env.SEARCH_TIMEOUT_MS ||= '650';

const {
  parseTrackButton,
  parseAlbumButton,
  inspectMeloBotAlbumListing,
  albumQueryMatches,
  resolveMeloBotArtistAlbums,
  openMeloBotAlbumByTitle,
  matchBulkAudioToTracks,
  searchMeloBot,
  chooseMeloBotSearchRefinement,
  albumNavigationButton,
  describeMeloBotSurface,
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
  trackPageKeyboard,
  SESSION_TTL_MS,
  BUSY_SESSION_TTL_MS,
} = await import('../src/ui.js');
const { CURATED_PLAYLISTS, HOME_FEEDS } = await import('../src/homeCatalog.js');
const {
  normalizeText,
  hasAlbumIntent,
  hasSpecificAlbumTitle,
  albumTitleAppearsInQuery,
} = await import('../src/text.js');

function fakeBotMessage(message, buttons = []) {
  return {
    message,
    replyMarkup: {
      rows: buttons.map(text => ({ buttons: [{ text }] })),
    },
  };
}

class FakeTelegramClient {
  constructor(script = {}) {
    this.script = new Map(
      Object.entries(script).map(([command, batches]) => [
        command,
        Array.isArray(batches?.[0]) ? [...batches] : [batches],
      ])
    );
    this.messages = [];
    this.sent = [];
    this.nextId = 1;
  }

  async getMessages() {
    return [...this.messages].sort((a, b) => b.id - a.id);
  }

  async sendMessage(_peer, { message }) {
    this.sent.push(message);
    const queue = this.script.get(message) || [];
    const batch = queue.shift() || [];
    this.script.set(message, queue);
    for (const item of batch) {
      this.messages.push({
        ...item,
        id: this.nextId++,
        out: false,
      });
    }
  }
}

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


test('canonical normalization treats Persian half-space album wording as separate tokens', () => {
  assert.equal(normalizeText('آلبوم‌های احسان خواجه امیری'), 'آلبوم های احسان خواجه امیری');
  assert.equal(hasAlbumIntent('آلبوم‌های احسان خواجه امیری'), true);
  assert.equal(hasSpecificAlbumTitle(
    'آلبوم‌های احسان خواجه امیری',
    'احسان خواجه امیری'
  ), false);
  assert.equal(hasSpecificAlbumTitle(
    'آلبوم احسان خواجه امیری پاییز تنهایی',
    'احسان خواجه امیری'
  ), true);
});

test('album listing with a next-page control stays partial until pagination finishes', () => {
  const listing = inspectMeloBotAlbumListing([{
    message: 'آلبوم های خواننده :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: '💿 Album One (8)' }] },
        { buttons: [{ text: 'بعدی' }] },
      ],
    },
  }]);

  assert.equal(listing.confirmed, true);
  assert.equal(listing.complete, false);
  assert.equal(listing.nextButton, 'بعدی');
});

test('generic Persian half-space album query matches all albums for the artist', () => {
  assert.equal(
    albumQueryMatches(
      'آلبوم‌های احسان خواجه امیری',
      'احسان خواجه امیری',
      'پاییز تنهایی'
    ),
    true
  );
});

test('specific album intent can be distinguished from an artist-only album query', () => {
  assert.equal(
    hasSpecificAlbumTitle('album Ehsan Khajeamiri', 'Ehsan Khajeamiri'),
    false
  );
  assert.equal(
    hasSpecificAlbumTitle('album Ehsan Khajeamiri In Roozha', 'Ehsan Khajeamiri'),
    true
  );
});

test('state-safe album opener is exported for paginated album flows', () => {
  assert.equal(typeof openMeloBotAlbumByTitle, 'function');
});

test('Ahangify track pages label HQ fallback as best available quality', () => {
  const keyboard = trackPageKeyboard(
    'sess',
    { source: 'ahangify', artist: 'Artist', title: 'Track' },
    {},
    { hasHq: true }
  );
  const labels = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.ok(labels.includes('📥 بهترین کیفیت موجود'));
  assert.equal(labels.includes('📥 کیفیت عالی'), false);
});

test('busy sessions outlive normal browsing sessions', () => {
  assert.ok(BUSY_SESSION_TTL_MS > SESSION_TTL_MS);
  assert.ok(BUSY_SESSION_TTL_MS >= 60 * 60 * 1000);
});


test('generic album query stays generic when source artist is transliterated', () => {
  assert.equal(
    hasSpecificAlbumTitle(
      'آلبوم احسان خواجه امیری',
      'Ehsan Khajeamiri',
      ['In Roozha', 'Paeiz Tanhaei']
    ),
    false
  );
});

test('specific album title is detected even when artist scripts differ', () => {
  assert.equal(
    albumTitleAppearsInQuery(
      'آلبوم احسان خواجه امیری In Roozha',
      'In Roozha'
    ),
    true
  );
  assert.equal(
    hasSpecificAlbumTitle(
      'آلبوم احسان خواجه امیری In Roozha',
      'Ehsan Khajeamiri',
      ['In Roozha', 'Paeiz Tanhaei']
    ),
    true
  );
});

test('misspelled extra title words do not silently become an all-albums query', () => {
  assert.equal(
    hasSpecificAlbumTitle(
      'album Ehsan Khajeamiri Wrong Album Name',
      'Ehsan Khajeamiri',
      ['In Roozha', 'Paeiz Tanhaei']
    ),
    true
  );
});


test('MeloBot search refinement chooses a song suggestion and ignores the not-in-list action', () => {
  const messages = [{
    message: 'خب حالا یکی از این آهنگا یا خواننده ها رو انتخاب کن :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: 'Arman Garshasbi Hezar Omid' }] },
        { buttons: [{ text: 'آهنگ در لیست نیست' }] },
      ],
    },
  }];

  assert.equal(
    chooseMeloBotSearchRefinement(messages, 'Arman Garshasbi'),
    'Arman Garshasbi Hezar Omid'
  );
});

test('MeloBot multi-step search follows suggestion text until a real track button appears', async () => {
  const client = new FakeTelegramClient({
    'Arman Garshasbi': [[
      fakeBotMessage(
        'خب حالا یکی از این آهنگا یا خواننده ها رو انتخاب کن :',
        ['Arman Garshasbi Hezar Omid', 'آهنگ در لیست نیست']
      ),
    ]],
    'Arman Garshasbi Hezar Omid': [[
      fakeBotMessage(
        'خب حالا یکی از این آهنگا یا خواننده ها رو انتخاب کن :',
        ['🎵 Arman Garshasbi, Hezar Omid']
      ),
    ]],
  });

  const tracks = await searchMeloBot(client, 'Arman Garshasbi', { maxRefinements: 3 });
  assert.equal(tracks[0].artist, 'Arman Garshasbi');
  assert.equal(tracks[0].title, 'Hezar Omid');
  assert.deepEqual(client.sent, [
    'Arman Garshasbi',
    'Arman Garshasbi Hezar Omid',
  ]);
});

test('MeloBot state machine allows the same reply label to be sent twice when state changes', async () => {
  const client = new FakeTelegramClient({
    Ebi: [
      [fakeBotMessage('انتخاب کن', ['Ebi'])],
      [fakeBotMessage('نتیجه', ['🎵 Ebi, Khalij'])],
    ],
  });

  const tracks = await searchMeloBot(client, 'Ebi', { maxRefinements: 2 });
  assert.equal(tracks[0].artist, 'Ebi');
  assert.equal(tracks[0].title, 'Khalij');
  assert.deepEqual(client.sent, ['Ebi', 'Ebi']);
});

test('MeloBot artist picker can lead to title-only tracks without misclassifying navigation', async () => {
  const client = new FakeTelegramClient({
    Singer: [[fakeBotMessage('خواننده را انتخاب کن', ['🗣 Singer'])]],
    '🗣 Singer': [[
      fakeBotMessage(
        'آهنگ های Singer',
        ['Song One', 'Song Two', 'نمایش به ترتیب تاریخ انتشار']
      ),
    ]],
  });

  const tracks = await searchMeloBot(client, 'Singer', { maxRefinements: 2 });
  assert.deepEqual(
    tracks.map(track => [track.artist, track.title]),
    [['Singer', 'Song One'], ['Singer', 'Song Two']]
  );
});

test('album navigation controls are recognized broadly and never parsed as tracks', () => {
  const variants = ['💿 آلبوم‌ها', 'البوم ها', 'Discography', '📀'];
  for (const label of variants) {
    const messages = [{
      message: 'artist',
      replyMarkup: { rows: [{ buttons: [{ text: label }] }] },
    }];
    assert.equal(albumNavigationButton(messages), label);
    assert.equal(parseTrackButton(label, 'Artist'), null);
  }
});

test('MeloBot source diagnostics keep both response text and reply buttons visible', () => {
  const surface = describeMeloBotSurface([{
    message: 'choose',
    replyMarkup: { rows: [{ buttons: [{ text: 'Suggestion' }] }] },
  }]);
  assert.match(surface, /choose/);
  assert.match(surface, /Suggestion/);
});
