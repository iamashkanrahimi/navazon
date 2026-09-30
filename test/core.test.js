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
  parseMeloBotSearchSurface,
  inspectMeloBotAlbumListing,
  albumQueryMatches,
  resolveMeloBotArtistAlbums,
  resolveMeloBotAlbumsFromLiveArtistContext,
  resolveMeloBotArtistAlbumsDirectFirst,
  openMeloBotArtist,
  openMeloBotAlbumByTitle,
  openMeloBotAlbumDirectByTitle,
  openMeloBotAlbumRobustByTitle,
  resolveMeloBotArtistTrackList,
  resolveMeloBotTrackCandidate,
  getMeloBotCover,
  getMeloBotLyrics,
  getMeloBotTrackMetadata,
  enrichMeloBotTrack,
  downloadMeloBotTrackQuality,
  downloadMeloBotAlbumTracks,
  getMeloBotAlbumPrimaryCircuitRemainingMs,
  matchBulkAudioToTracks,
  searchMeloBot,
  searchMeloBotTyped,
  classifyMeloBotTypedSearchExact,
  probeMeloBotCandidateSurface,
  chooseMeloBotSearchRefinement,
  albumNavigationButton,
  describeMeloBotSurface,
  getMeloBotStateVersion,
  findArtistButtonFor,
} = await import('../src/sources/melobot.js');
const { parseAhangifyResults } = await import('../src/ahangify.js');
const {
  installTelegramInbox,
  getTelegramInboxSequence,
  latestMessageId,
  collectNewMessages,
} = await import('../src/mtproto.js');
const { SerialQueue } = await import('../src/queue.js');
const { trackCacheKey } = await import('../src/cache.js');
const { DeepCatalog, deepTrackKey } = await import('../src/deepCatalog.js');
const { CatalogStore } = await import('../src/catalog.js');
const { db } = await import('../src/db.js');
const {
  resultsKeyboard,
  artistHomeKeyboard,
  albumTracksKeyboard,
  noAlbumsKeyboard,
  albumsErrorKeyboard,
  homeKeyboard,
  curatedPlaylistsKeyboard,
  trackPageKeyboard,
  trackPageTitle,
  trackButtonLabel,
  SESSION_TTL_MS,
  BUSY_SESSION_TTL_MS,
} = await import('../src/ui.js');
const { CURATED_PLAYLISTS, HOME_FEEDS } = await import('../src/homeCatalog.js');
const {
  normalizeText,
  hasAlbumIntent,
  hasSpecificAlbumTitle,
  albumTitleAppearsInQuery,
  shouldUseLiveAlbumDiscovery,
  meaningfulSearchTokens,
  rankTracksForQuery,
  shouldUseSearchRelevanceFallback,
  hasCompositeArtistSeparators,
  keepFullCoverageTracksWhenAvailable,
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

class FakeEventTelegramClient {
  constructor() {
    this.handlers = [];
    this.nextId = 1;
    this.historyCalls = 0;
  }

  addEventHandler(handler) {
    this.handlers.push(handler);
  }

  async getInputEntity(peer) {
    return { peer };
  }

  async getPeerId(input) {
    return input.peer === 'melobot' ? '42' : '43';
  }

  async getMessages() {
    this.historyCalls += 1;
    throw new Error('event-driven path must not poll history');
  }

  emit(senderId, message, extra = {}) {
    const msg = {
      id: this.nextId++,
      senderId: BigInt(senderId),
      out: false,
      message,
      ...extra,
    };
    for (const handler of this.handlers) {
      handler({ message: msg, chatId: BigInt(senderId) });
    }
    return msg;
  }
}

test('MeloBot parser extracts artist, title and popularity', () => {
  const track = parseTrackButton('🎵 Shadmehr, Taghdir x 1.6M');
  assert.equal(track.artist, 'Shadmehr');
  assert.equal(track.title, 'Taghdir');
  assert.equal(track.sourcePopularityCount, 1_600_000);
});

test('MeloBot parser rejects navigation and artist-sort controls', () => {
  assert.equal(parseTrackButton('بعدی'), null);
  assert.equal(parseTrackButton('صفحه بعد'), null);
  assert.equal(parseTrackButton('پربازدیدترین‌ها', 'Artist'), null);
  assert.equal(parseTrackButton('محبوب‌ترین ها', 'Artist'), null);
  assert.equal(parseTrackButton('نمایش به ترتیب تاریخ انتشار', 'Artist'), null);
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

  const tracks = await searchMeloBot(client, 'Arman Garshasbi', {
    maxRefinements: 3,
    timeoutMs: 3000,
  });
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

  const tracks = await searchMeloBot(client, 'Ebi', {
    maxRefinements: 2,
    timeoutMs: 3000,
  });
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

  const tracks = await searchMeloBot(client, 'Singer', {
    maxRefinements: 2,
    timeoutMs: 3000,
  });
  assert.deepEqual(
    tracks.map(track => [track.artist, track.title]),
    [['Singer', 'Song One'], ['Singer', 'Song Two']]
  );
});

test('album navigation controls are recognized broadly and never parsed as tracks', () => {
  const variants = ['💿 آلبوم‌ها', 'مشاهده آلبوم‌ها', 'البوم ها', 'Discography', '📀'];
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


test('MeloBot refinement loop stops when the same source surface repeats', async () => {
  const repeated = fakeBotMessage('انتخاب کن', ['Same Artist']);
  const client = new FakeTelegramClient({
    'Same Artist': [
      [repeated],
      [repeated],
      [repeated],
    ],
  });

  await assert.rejects(
    () => searchMeloBot(client, 'Same Artist', {
      maxRefinements: 5,
      timeoutMs: 3000,
    }),
    /no usable tracks/
  );

  assert.equal(client.sent.length, 2);
});

test('album rows are not mistaken for album-navigation controls', () => {
  const messages = [{
    message: 'albums',
    replyMarkup: {
      rows: [{ buttons: [{ text: '💿 In Roozha (8)' }] }],
    },
  }];
  assert.equal(albumNavigationButton(messages), null);
});


test('Arman-shaped multi-step source flow reaches the live album listing end-to-end', async () => {
  const exactTrack = '🎵 Arman Garshasbi, Hezar Omid';
  const client = new FakeTelegramClient({
    'Arman Garshasbi': [[
      fakeBotMessage(
        'خب حالا یکی از این آهنگا یا خواننده ها رو انتخاب کن :',
        ['Arman Garshasbi Hezar Omid', 'آهنگ در لیست نیست']
      ),
    ]],
    'Arman Garshasbi Hezar Omid': [
      [fakeBotMessage('انتخاب آهنگ', [exactTrack])],
      [fakeBotMessage('انتخاب آهنگ', [exactTrack])],
    ],
    [exactTrack]: [[
      fakeBotMessage(
        'صفحه آهنگ',
        ['📥 کیفیت عالی', '📥 کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'آهنگ های (1 - 10) : Arman Garshasbi',
        ['Hezar Omid', 'نمایش به ترتیب تاریخ انتشار', '💿 آلبوم‌ها']
      ),
    ]],
    '💿 آلبوم‌ها': [[
      fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 Album One (8)', '💿 Album Two (3)']
      ),
    ]],
  });

  const resolved = await resolveMeloBotArtistAlbums(
    client,
    'Arman Garshasbi',
    null,
    { allowEmpty: true, maxAlbums: 20, timeoutMs: 8000 }
  );

  assert.equal(resolved.artist, 'Arman Garshasbi');
  assert.equal(resolved.complete, true);
  assert.deepEqual(
    resolved.albums.map(album => [album.title, album.trackCount]),
    [['Album One', 8], ['Album Two', 3]]
  );
  assert.ok(client.sent.includes('💿 آلبوم‌ها'));
});


test('Ebi-style missing artist button falls back to the direct album route', async () => {
  const exactTrack = '🎵 Ebi, Khalij';
  const client = new FakeTelegramClient({
    Ebi: [
      [fakeBotMessage('search results', [exactTrack])],
      [fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 Shabe Niloufari (9)', '💿 Hasrate Parvaz (8)']
      )],
    ],
    'Ebi Khalij': [[fakeBotMessage('search results', [exactTrack])]],
    [exactTrack]: [[
      fakeBotMessage(
        'صفحه آهنگ بدون دکمه خواننده',
        ['📥 کیفیت عالی', '📥 کیفیت معمولی']
      ),
    ]],
  });

  const resolved = await resolveMeloBotArtistAlbums(
    client,
    'Ebi',
    null,
    { allowEmpty: true, maxAlbums: 20, timeoutMs: 4000 }
  );

  assert.equal(resolved.source, 'direct_fallback');
  assert.deepEqual(
    resolved.albums.map(album => album.title),
    ['Shabe Niloufari', 'Hasrate Parvaz']
  );
  assert.equal(resolved.complete, true);
});


test('event-driven MTProto inbox receives replies without GetHistory polling', async () => {
  const client = new FakeEventTelegramClient();
  installTelegramInbox(client);

  const afterId = await latestMessageId(client, 'melobot');
  const pending = collectNewMessages(client, 'melobot', afterId, {
    timeoutMs: 300,
    quietMs: 20,
  });

  client.emit(42, 'hello from source');
  const result = await pending;

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message, 'hello from source');
  assert.equal(client.historyCalls, 0);
});

test('target-aware MTProto collection does not stop on a short quiet gap before media', async () => {
  const client = new FakeEventTelegramClient();
  installTelegramInbox(client);

  const afterId = await latestMessageId(client, 'melobot');
  const pending = collectNewMessages(client, 'melobot', afterId, {
    timeoutMs: 300,
    quietMs: 20,
    waitForTarget: true,
    stopWhen: message => Boolean(message?.media?.document),
  });

  client.emit(42, 'در حال آماده سازی');
  await new Promise(resolve => setTimeout(resolve, 45));
  client.emit(42, '', {
    media: {
      document: {
        mimeType: 'audio/mpeg',
        attributes: [],
      },
    },
  });

  const result = await pending;
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.some(message => message?.media?.document));
  assert.equal(client.historyCalls, 0);
});

test('stale Track state refreshes search surface before clicking the Track row', async () => {
  const raw = '🎵 Reza Bahram, Yar';
  const normal = '📥 کیفیت معمولی';
  const query = 'Reza Bahram Yar';
  const client = new FakeTelegramClient({
    [query]: [[fakeBotMessage('search results', [raw])]],
    [raw]: [[fakeBotMessage('خب حالا میخوای با این آهنگ چه کنی ؟', [
      '📥 کیفیت عالی',
      normal,
      'بیشتر...',
    ])]],
    [normal]: [[{
      message: '',
      media: {
        document: {
          mimeType: 'audio/mpeg',
          attributes: [],
        },
      },
    }]],
  });

  const result = await downloadMeloBotTrackQuality(
    client,
    {
      source: 'melobot',
      artist: 'Reza Bahram',
      title: 'Yar',
      rawText: raw,
      sourceStateVersion: 1,
    },
    'normal',
    {
      timeoutMs: 1800,
      menuTimeoutMs: 400,
      deliveryTimeoutMs: 400,
    }
  );

  assert.equal(result.quality, 'normal');
  assert.deepEqual(client.sent, [query, raw, normal]);
  assert.ok(result.audioMessage?.media?.document);
});

test('cover delivery follows More and waits for the actual photo target', async () => {
  const raw = '🎵 Navid, Rah Mire';
  const more = 'بیشتر...';
  const cover = 'کاور';
  const client = new FakeTelegramClient({
    [raw]: [[fakeBotMessage('track menu', [
      '📥 کیفیت عالی',
      '📥 کیفیت معمولی',
      more,
    ])]],
    [more]: [[fakeBotMessage('more menu', [cover, 'متن آهنگ'])]],
    [cover]: [[{
      message: '',
      media: { photo: { id: 'photo-1' } },
    }]],
  });

  const result = await getMeloBotCover(
    client,
    {
      source: 'melobot',
      artist: 'Navid',
      title: 'Rah Mire',
      rawText: raw,
      sourceStateVersion: 1,
    },
    {
      timeoutMs: 900,
      menuTimeoutMs: 400,
      submenuTimeoutMs: 400,
      deliveryTimeoutMs: 400,
    }
  );

  assert.equal(result.available, true);
  assert.deepEqual(client.sent, [raw, more, cover]);
  assert.ok(result.photoMessage?.media?.photo);
});

test('priority serial queue lets interactive work jump ahead of queued background work', async () => {
  const order = [];
  let releaseActive;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });

  const queue = new SerialQueue(async item => {
    order.push(item.id);
    if (item.id === 'active-background') await activeGate;
  }, {
    priorityOf: item => item.interactive ? 100 : 0,
  });

  queue.push({ id: 'active-background', interactive: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  queue.push({ id: 'queued-background', interactive: false });
  queue.push({ id: 'interactive', interactive: true });

  releaseActive();

  const deadline = Date.now() + 500;
  while (!queue.isIdle() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.deepEqual(order, ['active-background', 'interactive', 'queued-background']);
});

test('parsed MeloBot rows carry the current live source-state token', () => {
  const current = getMeloBotStateVersion();
  assert.equal(
    parseTrackButton('🎵 Artist, Song').sourceStateVersion,
    current
  );
  assert.equal(
    parseAlbumButton('💿 Album (5)').sourceStateVersion,
    current
  );
});


test('matching preferred artist seed skips a redundant artist search before navigation', async () => {
  const seed = {
    ...parseTrackButton('🎵 Fast Artist, Seed Song'),
    source: 'melobot',
  };
  const client = new FakeTelegramClient({
    '🎵 Fast Artist, Seed Song': [[
      fakeBotMessage('صفحه آهنگ', ['📥 کیفیت عالی', '🎤 خواننده']),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'آهنگ های Fast Artist',
        ['Seed Song', '💿 آلبوم‌ها']
      ),
    ]],
    '💿 آلبوم‌ها': [[
      fakeBotMessage(
        'آلبوم های خواننده (1) :',
        ['💿 Fast Album (4)']
      ),
    ]],
  });

  const resolved = await resolveMeloBotArtistAlbums(
    client,
    'Fast Artist',
    seed,
    { allowEmpty: true, maxAlbums: 10 }
  );

  assert.deepEqual(resolved.albums.map(album => album.title), ['Fast Album']);
  assert.equal(client.sent.includes('Fast Artist'), false);
  assert.deepEqual(client.sent, [
    '🎵 Fast Artist, Seed Song',
    '🎤 خواننده',
    '💿 آلبوم‌ها',
  ]);
});


test('ordinary artist and track searches never trigger live album discovery', () => {
  assert.equal(shouldUseLiveAlbumDiscovery('Arman Garshasbi'), false);
  assert.equal(shouldUseLiveAlbumDiscovery('Arman Garshasbi Hezar Omid'), false);
  assert.equal(shouldUseLiveAlbumDiscovery('album Arman Garshasbi'), true);
  assert.equal(shouldUseLiveAlbumDiscovery('آلبوم‌های آرمان گرشاسبی'), true);
});

test('direct album-title opener clicks the live target without artist-page navigation', async () => {
  const client = new FakeTelegramClient({
    'Fast Direct Artist': [[
      fakeBotMessage(
        'آلبوم های خواننده (1) :',
        ['💿 Fast Direct Album (2)']
      ),
    ]],
    '💿 Fast Direct Album (2)': [[
      fakeBotMessage(
        'Fast Direct Album',
        ['Track One', 'Track Two', '📥 دانلود همه (عالی)']
      ),
    ]],
  });

  const opened = await openMeloBotAlbumDirectByTitle(
    client,
    'Fast Direct Artist',
    'Fast Direct Album',
    { timeoutMs: 2500, maxPages: 3 }
  );

  assert.equal(opened.album.title, 'Fast Direct Album');
  assert.deepEqual(opened.tracks.map(track => track.title), ['Track One', 'Track Two']);
  assert.equal(opened.bulkHighButton, '📥 دانلود همه (عالی)');
  assert.deepEqual(client.sent, [
    'Fast Direct Artist',
    '💿 Fast Direct Album (2)',
  ]);
});

test('direct album-title opener follows pagination and clicks only when target page is live', async () => {
  const client = new FakeTelegramClient({
    'Paged Direct Artist': [[
      fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 Album One (1)', 'بعدی']
      ),
    ]],
    'بعدی': [[
      fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 Album Two (1)']
      ),
    ]],
    '💿 Album Two (1)': [[
      fakeBotMessage(
        'Album Two',
        ['Only Track', '📥 دانلود همه (عالی)']
      ),
    ]],
  });

  const opened = await openMeloBotAlbumDirectByTitle(
    client,
    'Paged Direct Artist',
    'Album Two',
    { timeoutMs: 2500, maxPages: 3 }
  );

  assert.equal(opened.album.title, 'Album Two');
  assert.deepEqual(client.sent, [
    'Paged Direct Artist',
    'بعدی',
    '💿 Album Two (1)',
  ]);
});

test('failed primary album route opens a temporary circuit before direct fallback', async () => {
  const exactTrack = '🎵 Circuit Artist, Seed';
  const client = new FakeTelegramClient({
    'Circuit Artist': [
      [fakeBotMessage('search results', [exactTrack])],
      [fakeBotMessage(
        'آلبوم های خواننده (1) :',
        ['💿 Circuit Album (1)']
      )],
    ],
    [exactTrack]: [[
      fakeBotMessage(
        'track page without artist control',
        ['📥 کیفیت عالی', '📥 کیفیت معمولی']
      ),
    ]],
    '💿 Circuit Album (1)': [[
      fakeBotMessage(
        'Circuit Album',
        ['Only Track', '📥 دانلود همه (عالی)']
      ),
    ]],
  });

  const opened = await openMeloBotAlbumByTitle(
    client,
    'Circuit Artist',
    'Circuit Album',
    null,
    { maxPages: 3 }
  );

  assert.equal(opened.album.title, 'Circuit Album');
  assert.ok(getMeloBotAlbumPrimaryCircuitRemainingMs('Circuit Artist') > 0);
});


test('live artist album surface resolves with one direct button click', async () => {
  const client = new FakeTelegramClient({
    '💿 آلبوم‌ها': [[
      fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 Live One (3)', '💿 Live Two (4)']
      ),
    ]],
  });

  const context = {
    artist: 'Live Artist',
    liveAlbumButton: '💿 آلبوم‌ها',
    liveAlbumList: [],
    liveAlbumListingConfirmed: false,
    liveAlbumListingConfirmedEmpty: false,
    liveAlbumDeclaredCount: null,
    liveAlbumNextButton: null,
    liveAlbumSourceStateVersion: getMeloBotStateVersion(),
  };

  const resolved = await resolveMeloBotAlbumsFromLiveArtistContext(
    client,
    context,
    { allowEmpty: true, maxAlbums: 10 }
  );

  assert.deepEqual(
    resolved.albums.map(album => album.title),
    ['Live One', 'Live Two']
  );
  assert.deepEqual(client.sent, ['💿 آلبوم‌ها']);
  assert.match(resolved.source, /^live_artist_surface:/);
});

test('stale live artist album surface is never clicked', async () => {
  const client = new FakeTelegramClient({
    '💿 آلبوم‌ها': [[
      fakeBotMessage('آلبوم های خواننده (1) :', ['💿 Should Not Open (1)']),
    ]],
  });

  await assert.rejects(
    () => resolveMeloBotAlbumsFromLiveArtistContext(
      client,
      {
        artist: 'Stale Artist',
        liveAlbumButton: '💿 آلبوم‌ها',
        liveAlbumListingConfirmed: false,
        liveAlbumSourceStateVersion: getMeloBotStateVersion() - 1,
      },
      { allowEmpty: true }
    ),
    /stale/
  );

  assert.deepEqual(client.sent, []);
});

test('artist sorting records only the final reply keyboard as a live album surface', async () => {
  const exactTrack = '🎵 Surface Artist, Seed Song';
  const seed = {
    ...parseTrackButton(exactTrack),
    source: 'melobot',
  };

  const client = new FakeTelegramClient({
    [exactTrack]: [[
      fakeBotMessage(
        'track page',
        ['📥 کیفیت عالی', '🎤 خواننده']
      ),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'آهنگ های Surface Artist',
        ['Seed Song', 'نمایش به ترتیب تاریخ انتشار', '💿 stale albums']
      ),
    ]],
    'نمایش به ترتیب تاریخ انتشار': [[
      fakeBotMessage(
        'مرتب سازی',
        ['پربازدیدترین‌ها']
      ),
    ]],
    'پربازدیدترین‌ها': [[
      fakeBotMessage(
        'پربازدیدترین آهنگ ها',
        ['Top Song', '📥 دانلود همه (عالی)', '💿 آلبوم‌ها']
      ),
    ]],
  });

  const opened = await openMeloBotArtist(client, seed);

  assert.equal(opened.liveAlbumButton, '💿 آلبوم‌ها');
  assert.equal(
    opened.liveAlbumSourceStateVersion,
    getMeloBotStateVersion()
  );
  assert.notEqual(opened.liveAlbumButton, '💿 stale albums');
});

test('direct-first album listing returns before attempting artist-page navigation', async () => {
  const client = new FakeTelegramClient({
    'Direct Albums Artist': [[
      fakeBotMessage(
        'آلبوم های خواننده (2) :',
        ['💿 First Album (2)', '💿 Second Album (5)']
      ),
    ]],
  });

  const resolved = await resolveMeloBotArtistAlbumsDirectFirst(
    client,
    'Direct Albums Artist',
    null,
    {
      allowEmpty: true,
      maxAlbums: 10,
      directTimeoutMs: 650,
    }
  );

  assert.deepEqual(
    resolved.albums.map(album => album.title),
    ['First Album', 'Second Album']
  );
  assert.match(resolved.source, /^direct_first:/);
  assert.deepEqual(client.sent, ['Direct Albums Artist']);
});


test('disc-prefixed album search rows are albums and never tracks', () => {
  const loose = parseAlbumButton('💿 Bahram, Eshtebahe Khoob');
  assert.equal(loose.artist, 'Bahram');
  assert.equal(loose.title, 'Eshtebahe Khoob');
  assert.equal(parseTrackButton('💿 Bahram, Eshtebahe Khoob'), null);
  assert.equal(parseAlbumButton('💿 آلبوم‌ها'), null);

  assert.equal(parseAlbumButton('Album of the Year (10)'), null);
  const counted = parseAlbumButton('Album of the Year (10)', { allowBareCounted: true });
  assert.equal(counted.title, 'Album of the Year');
  assert.equal(counted.trackCount, 10);
});

test('typed MeloBot search keeps disc-prefixed results as albums', async () => {
  const client = new FakeTelegramClient({
    'Bahram Eshtebahe Khoob': [[
      fakeBotMessage(
        'نتیجه جستجو',
        ['💿 Bahram, Eshtebahe Khoob']
      ),
    ]],
  });

  const result = await searchMeloBotTyped(client, 'Bahram Eshtebahe Khoob');
  assert.equal(result.tracks.length, 0);
  assert.equal(result.albums.length, 1);
  assert.equal(result.albums[0].artist, 'Bahram');
  assert.equal(result.albums[0].title, 'Eshtebahe Khoob');
  assert.deepEqual(client.sent, ['Bahram Eshtebahe Khoob']);
});

test('exact track-looking search hit is reclassified when it opens an album page', async () => {
  const ambiguous = '🎵 Hichkas, Mojaz';
  const client = new FakeTelegramClient({
    'Hichkas Mojaz': [[
      fakeBotMessage('نتیجه جستجو', [ambiguous]),
    ]],
    [ambiguous]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آلبوم چه کنی ؟',
        [
          'دانلود همه (عالی)',
          'دانلود همه (معمولی)',
          '🎵 Rosva x 2.5M',
          '🎵 To Koja Boodi x 3M',
        ]
      ),
    ]],
  });

  const typed = await searchMeloBotTyped(client, 'Hichkas Mojaz');
  assert.equal(typed.tracks.length, 1);

  const classified = await classifyMeloBotTypedSearchExact(
    client,
    'Hichkas Mojaz',
    typed
  );

  assert.equal(classified.exactProbe, 'album');
  assert.equal(classified.tracks.length, 0);
  assert.equal(classified.albums.length, 1);
  assert.equal(classified.albums[0].artist, 'Hichkas');
  assert.equal(classified.albums[0].title, 'Mojaz');
  assert.deepEqual(
    classified.albums[0].tracks.map(track => track.title),
    ['Rosva', 'To Koja Boodi']
  );
});

test('candidate surface probe leaves a genuine exact track typed as a track', async () => {
  const raw = '🎵 Artist, Real Song';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آهنگ چه کنی ؟',
        ['کیفیت عالی', 'کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
  });

  const candidate = parseTrackButton(raw);
  const probed = await probeMeloBotCandidateSurface(client, candidate);
  assert.equal(probed.kind, 'track');
  assert.equal(probed.candidate.title, 'Real Song');
});

test('artist navigation recovers from an album page through a real album track', async () => {
  const ambiguous = '🎵 Bahram, Eshtebahe Khoob';
  const client = new FakeTelegramClient({
    [ambiguous]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آلبوم چه کنی ؟',
        [
          'دانلود همه (عالی)',
          '🎵 Khoob x 3.5M',
          '🎵 Saz x 3.3M',
        ]
      ),
    ]],
    '🎵 Khoob x 3.5M': [[
      fakeBotMessage(
        'خب حالا میخوای با این آهنگ چه کنی ؟',
        ['کیفیت عالی', 'کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'آهنگ های Bahram',
        ['Khoob', 'Saz', '💿 آلبوم‌ها']
      ),
    ]],
  });

  const seed = {
    ...parseTrackButton(ambiguous),
    source: 'melobot',
  };

  const artist = await openMeloBotArtist(client, seed);

  assert.equal(artist.artist, 'Bahram');
  assert.equal(artist.recoveredFromAlbum, true);
  assert.equal(artist.seedTrack.title, 'Khoob');
  assert.deepEqual(
    artist.recentTracks.map(track => track.title),
    ['Khoob', 'Saz']
  );
  assert.deepEqual(client.sent, [
    ambiguous,
    '🎵 Khoob x 3.5M',
    '🎤 خواننده',
  ]);
});

test('empty artist surfaces fail closed instead of producing a broken artist page', async () => {
  const raw = '🎵 Empty Artist, Seed';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آهنگ چه کنی ؟',
        ['کیفیت عالی', 'کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'Empty Artist',
        ['💿 آلبوم‌ها']
      ),
    ]],
    'Empty Artist': [[
      fakeBotMessage('نتیجه‌ای پیدا نشد', [])
    ]],
  });

  const seed = {
    ...parseTrackButton(raw),
    source: 'melobot',
  };

  await assert.rejects(
    () => openMeloBotArtist(client, seed),
    /no usable tracks/
  );
});


test('typed search splits counted disc rows into artist and album without changing album-list parsing', () => {
  const surface = parseMeloBotSearchSurface([{
    message: 'search',
    replyMarkup: {
      rows: [{ buttons: [{ text: '💿 Hichkas, Mojaz (14)' }] }],
    },
  }]);

  assert.equal(surface.albums.length, 1);
  assert.equal(surface.albums[0].artist, 'Hichkas');
  assert.equal(surface.albums[0].title, 'Mojaz');
  assert.equal(surface.albums[0].trackCount, 14);

  const listingRow = parseAlbumButton('💿 Mojaz, Vol. 2 (14)');
  assert.equal(listingRow.artist, undefined);
  assert.equal(listingRow.title, 'Mojaz, Vol. 2');
});


test('exact high-confidence track rows skip the album probe for lower latency', async () => {
  const client = new FakeTelegramClient({});
  const track = parseTrackButton('🎵 Artist, Real Song x 1.2M');

  const classified = await classifyMeloBotTypedSearchExact(
    client,
    'Artist Real Song',
    { tracks: [track], albums: [] }
  );

  assert.equal(classified.exactProbe, 'skipped_confident_track');
  assert.equal(classified.tracks.length, 1);
  assert.equal(classified.albums.length, 0);
  assert.deepEqual(client.sent, []);
});


test('mixed exact search probes ambiguous track even when an album result already exists', async () => {
  const ambiguous = '🎵 Shayea, Do Be Shak';
  const albumRow = '💿 Shayea, Do Be Shak';
  const client = new FakeTelegramClient({
    'shayea do be shak': [[
      fakeBotMessage('نتیجه جستجو', [ambiguous, albumRow]),
    ]],
    [ambiguous]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آلبوم چه کنی ؟',
        [
          'دانلود همه (عالی)',
          '🎵 Track One x 1.1M',
          '🎵 Track Two x 900K',
        ]
      ),
    ]],
  });

  const typed = await searchMeloBotTyped(client, 'shayea do be shak');
  assert.equal(typed.tracks.length, 1);
  assert.equal(typed.albums.length, 1);

  const classified = await classifyMeloBotTypedSearchExact(
    client,
    'shayea do be shak',
    typed
  );

  assert.equal(classified.exactProbe, 'album');
  assert.equal(classified.tracks.length, 0);
  assert.equal(classified.albums.length, 1);
  assert.equal(classified.albums[0].artist, 'Shayea');
  assert.equal(classified.albums[0].title, 'Do Be Shak');
});

test('mixed exact search keeps a genuine low-confidence track even when albums are also present', async () => {
  const exactTrack = '🎵 Artist, Real Song';
  const client = new FakeTelegramClient({
    [exactTrack]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آهنگ چه کنی ؟',
        ['کیفیت عالی', 'کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
  });

  const classified = await classifyMeloBotTypedSearchExact(
    client,
    'Artist Real Song',
    {
      tracks: [parseTrackButton(exactTrack)],
      albums: [{ type: 'album', artist: 'Artist', title: 'Other Album' }],
    }
  );

  assert.equal(classified.exactProbe, 'track');
  assert.equal(classified.tracks.length, 1);
  assert.equal(classified.albums.length, 1);
});

test('single MeloBot search row never creates a direct artist-page shortcut', () => {
  const session = {
    options: [
      { source: 'melobot', artist: 'Shayea', title: 'Do Be Shak' },
    ],
    albumOptions: [
      { source: 'melobot', artist: 'Shayea', title: 'Do Be Shak' },
    ],
  };

  const keyboard = resultsKeyboard('single1', session);
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.some(value => value?.startsWith('ar:single1:')), false);
});

test('two consistent MeloBot track rows still create the direct artist-page shortcut', () => {
  const session = {
    options: [
      { source: 'melobot', artist: 'Shayea', title: 'One' },
      { source: 'melobot', artist: 'Shayea', title: 'Two' },
    ],
    albumOptions: [],
  };

  const keyboard = resultsKeyboard('multi2', session);
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.includes('ar:multi2:0'), true);
});

test('artist recovery accepts two exact-artist rows without popularity metadata', async () => {
  const seedRaw = '🎵 Shayea, Odd Seed';
  const client = new FakeTelegramClient({
    [seedRaw]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آهنگ چه کنی ؟',
        ['کیفیت عالی', 'کیفیت معمولی', '🎤 خواننده']
      ),
    ]],
    '🎤 خواننده': [[
      fakeBotMessage(
        'Shayea',
        ['نمایش به ترتیب تاریخ انتشار']
      ),
    ]],
    'نمایش به ترتیب تاریخ انتشار': [[
      fakeBotMessage('مرتب سازی', ['پربازدیدترین‌ها']),
    ]],
    'پربازدیدترین‌ها': [[
      fakeBotMessage('بدون ردیف آهنگ', []),
    ]],
    'Shayea': [[
      fakeBotMessage(
        'نتیجه جستجو',
        ['🎵 Shayea, Search One', '🎵 Shayea, Search Two']
      ),
    ]],
  });

  const artist = await openMeloBotArtist(client, {
    ...parseTrackButton(seedRaw),
    source: 'melobot',
  });

  assert.equal(artist.artist, 'Shayea');
  assert.deepEqual(
    artist.topTracks.map(track => track.title),
    ['Search One', 'Search Two']
  );
});

test('quality-aware media lookup returns only the requested HQ rows in one query', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return {
      rows: [{
        track_key: deepTrackKey({ artist: 'A', title: 'One' }),
        quality: 'hq',
        file_id: 'hq-file',
        file_unique_id: 'u1',
        kind: 'audio',
        bitrate: 320,
        file_size: 1234,
        duration_seconds: 180,
        source: 'melobot',
      }],
    };
  };

  try {
    const catalog = new DeepCatalog();
    const media = await catalog.getMediaMap([
      { artist: 'A', title: 'One' },
      { artist: 'A', title: 'Two' },
    ], 'hq');

    assert.equal(media.size, 1);
    assert.equal(media.get('a|one').fileId, 'hq-file');
    assert.equal(media.get('a|one').quality, 'hq');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[0], 'hq');
    assert.deepEqual(calls[0].params[1].sort(), ['a|one', 'a|two']);
    assert.match(calls[0].sql, /verified_quality\s*=\s*TRUE/i);
  } finally {
    db.query = originalQuery;
  }
});

test('query-shape regression matrix keeps track album and artist-only cases distinct', async () => {
  const cases = [
    {
      name: 'artist only',
      query: 'Hichkas',
      buttons: [
        '🎵 Hichkas, Track One x 2M',
        '🎵 Hichkas, Track Two x 1M',
        '💿 Hichkas, Mojaz',
      ],
      expectedTracks: 2,
      expectedAlbums: 1,
    },
    {
      name: 'exact popular track',
      query: 'Hichkas Track One',
      buttons: ['🎵 Hichkas, Track One x 2M'],
      expectedTracks: 1,
      expectedAlbums: 0,
    },
    {
      name: 'disc album',
      query: 'Bahram Eshtebahe Khoob',
      buttons: ['💿 Bahram, Eshtebahe Khoob'],
      expectedTracks: 0,
      expectedAlbums: 1,
    },
    {
      name: 'counted disc album',
      query: 'Hichkas Mojaz',
      buttons: ['💿 Hichkas, Mojaz (14)'],
      expectedTracks: 0,
      expectedAlbums: 1,
    },
    {
      name: 'persian artist search',
      query: 'هیچکس',
      buttons: ['🎵 هیچکس, آهنگ یک x 1M', '🎵 هیچکس, آهنگ دو x 900K'],
      expectedTracks: 2,
      expectedAlbums: 0,
    },
  ];

  for (const item of cases) {
    const client = new FakeTelegramClient({
      [item.query]: [[fakeBotMessage(item.name, item.buttons)]],
    });
    const typed = await searchMeloBotTyped(client, item.query);
    assert.equal(typed.tracks.length, item.expectedTracks, item.name);
    assert.equal(typed.albums.length, item.expectedAlbums, item.name);
  }
});


test('deep media details query ignores pre-v1.5.4 unverified quality rows', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes('FROM deep_track_media')) return { rows: [] };
    if (text.includes('FROM deep_tracks')) return {
      rows: [{
        track_key: 'a|one',
        artist: 'A',
        title: 'One',
        metadata: {},
      }],
    };
    if (text.includes('FROM deep_album_tracks')) return { rows: [] };
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    const details = await catalog.getTrackDetails({ artist: 'A', title: 'One' });
    assert.deepEqual(details.media, {});
  } finally {
    db.query = originalQuery;
  }

  const mediaSql = calls.find(call => call.sql.includes('FROM deep_track_media'))?.sql || '';
  assert.match(mediaSql, /verified_quality\s*=\s*TRUE/i);
});


test('crawler treats unverified legacy media as missing quality cache', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    const missing = await catalog.missingMediaTracks([
      { artist: 'Legacy Artist', title: 'Legacy Track' },
    ], 'hq');

    assert.equal(missing.length, 1);
    assert.equal(missing[0].title, 'Legacy Track');
  } finally {
    db.query = originalQuery;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /verified_quality\s*=\s*TRUE/i);
  assert.equal(calls[0].params[0], 'hq');
});

test('explicit track rows with parenthesized titles are not misclassified as albums', () => {
  const track = parseTrackButton('🎵 Artist, Song (2024)');
  assert.equal(track.artist, 'Artist');
  assert.equal(track.title, 'Song (2024)');

  const surface = parseMeloBotSearchSurface([{
    message: 'search',
    replyMarkup: {
      rows: [{ buttons: [{ text: '🎵 Artist, Song (2024)' }] }],
    },
  }]);

  assert.equal(surface.tracks.length, 1);
  assert.equal(surface.tracks[0].title, 'Song (2024)');
  assert.equal(surface.albums.length, 0);

  assert.equal(parseAlbumButton('Album Title (10)'), null);
  const album = parseAlbumButton('Album Title (10)', { allowBareCounted: true });
  assert.equal(album.title, 'Album Title');
  assert.equal(album.trackCount, 10);
});

test('query-shape matrix covers punctuation ordering numerals and Persian spacing', async () => {
  const cases = [
    { name: 'dash separated exact track', query: 'Artist Song Name', buttons: ['🎵 Artist - Song Name x 750K'], tracks: 1, albums: 0 },
    { name: 'parenthesized track title', query: 'Artist Song 2024', buttons: ['🎵 Artist, Song (2024)'], tracks: 1, albums: 0 },
    { name: 'album with Persian digits', query: 'Artist Album', buttons: ['💿 Artist, Album (۱۲)'], tracks: 0, albums: 1 },
    { name: 'Persian comma track', query: 'هیچکس آهنگ', buttons: ['🎵 هیچکس, آهنگ جدید x 2.1M'], tracks: 1, albums: 0 },
    { name: 'English album dash', query: 'Shayea Do Be Shak', buttons: ['💿 Shayea — Do Be Shak'], tracks: 0, albums: 1 },
    { name: 'mixed artist surface', query: 'Shayea', buttons: ['🎵 Shayea, Track One x 1M', '🎵 Shayea, Track Two x 800K', '💿 Shayea, Do Be Shak', '💿 Shayea, Injaneb'], tracks: 2, albums: 2 },
  ];

  for (const item of cases) {
    const client = new FakeTelegramClient({
      [item.query]: [[fakeBotMessage(item.name, item.buttons)]],
    });
    const typed = await searchMeloBotTyped(client, item.query);
    assert.equal(typed.tracks.length, item.tracks, item.name + ': tracks');
    assert.equal(typed.albums.length, item.albums, item.name + ': albums');
  }

  assert.equal(hasAlbumIntent('آلبوم‌های شایع'), true);
  assert.equal(hasAlbumIntent('البوم های شایع'), true);
  assert.equal(hasAlbumIntent('album Shayea'), true);
});

test('same-name track and album collision is probed even when the track has popularity', async () => {
  const exactTrack = '🎵 Shayea, Do Be Shak x 2M';
  const client = new FakeTelegramClient({
    [exactTrack]: [[
      fakeBotMessage(
        'خب حالا میخوای با این آلبوم چه کنی ؟',
        ['دانلود همه (عالی)', '🎵 One x 1M', '🎵 Two x 900K']
      ),
    ]],
  });

  const classified = await classifyMeloBotTypedSearchExact(
    client,
    'Shayea Do Be Shak',
    {
      tracks: [parseTrackButton(exactTrack)],
      albums: [{ type: 'album', artist: 'Shayea', title: 'Do Be Shak' }],
    }
  );

  assert.equal(classified.exactProbe, 'album');
  assert.equal(classified.tracks.length, 0);
  assert.equal(classified.albums.length, 1);
  assert.equal(classified.albums[0].tracks.length, 2);
});

test('album-only search exposes a safe Artist-page shortcut from the album artist', () => {
  const session = {
    options: [],
    albumOptions: [
      { source: 'melobot', artist: 'Shayea', title: 'Do Be Shak' },
    ],
  };

  const keyboard = resultsKeyboard('albumartist1', session);
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.includes('aar:albumartist1:0'), true);
});

test('mixed album artists do not create an ambiguous album-derived Artist shortcut', () => {
  const session = {
    options: [],
    albumOptions: [
      { source: 'melobot', artist: 'Artist A', title: 'Album A' },
      { source: 'melobot', artist: 'Artist B', title: 'Album B' },
    ],
  };

  const keyboard = resultsKeyboard('albumartist2', session);
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.some(value => value?.startsWith('aar:')), false);
});

test('interactive album bulk honors a short caller timeout instead of the legacy multi-minute wait', async () => {
  const client = new FakeTelegramClient({
    'دانلود همه (عالی)': [[]],
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => downloadMeloBotAlbumTracks(
      client,
      {
        album: { title: 'Fast Fail Album' },
        tracks: [{ artist: 'A', title: 'One' }],
        bulkHighButton: 'دانلود همه (عالی)',
      },
      { timeoutMs: 30 }
    ),
    /did not deliver audio/
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1200, `expected bounded failure, got ${elapsed}ms`);
});

test('artist home always shows top and recent actions even when one list is missing', () => {
  const keyboard = artistHomeKeyboard(
    'always1',
    { artist: 'Haamim', topTracks: [{ artist: 'Haamim', title: 'One' }], recentTracks: [] },
    false
  );
  const texts = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.ok(texts.includes('🎵 پربازدیدترین آثار'));
  assert.ok(texts.includes('🆕 جدیدترین آثار'));
});

test('recent artist list can be recovered from the release-date sort surface', async () => {
  const seedRaw = '🎵 Artist, Seed';
  const client = new FakeTelegramClient({
    [seedRaw]: [[fakeBotMessage('track', ['کیفیت عالی', '🎤 خواننده'])]],
    '🎤 خواننده': [[fakeBotMessage('Artist', ['نمایش به ترتیب تاریخ انتشار'])]],
    'نمایش به ترتیب تاریخ انتشار': [[
      fakeBotMessage(
        'جدیدترین آثار',
        ['🎵 Artist, New One', '🎵 Artist, New Two', 'دانلود همه (عالی)']
      ),
    ]],
  });

  const resolved = await resolveMeloBotArtistTrackList(
    client,
    'Artist',
    'recent',
    { ...parseTrackButton(seedRaw), source: 'melobot' }
  );

  assert.equal(resolved.mode, 'recent');
  assert.equal(resolved.route, 'artist_sort_direct_recent');
  assert.deepEqual(resolved.tracks.map(track => track.title), ['New One', 'New Two']);
  assert.equal(resolved.context.recentBulkHighButton, 'دانلود همه (عالی)');
});

test('robust album opener falls back to a collaborator component when combined artist lookup misses', async () => {
  const targetRow = '💿 Khoone Khorshid (2)';
  const client = new FakeTelegramClient({
    'Bahram & Ali Sorena': [[fakeBotMessage('albums', ['💿 Other Album (1)'])]],
    'Bahram & Ali Sorena Khoone Khorshid': [[]],
    'Khoone Khorshid': [[]],
    'Bahram': [[fakeBotMessage('albums', [targetRow])]],
    [targetRow]: [[
      fakeBotMessage(
        'album page',
        ['🎵 Bahram, Track One', '🎵 Bahram, Track Two', 'دانلود همه (عالی)']
      ),
    ]],
  });

  const opened = await openMeloBotAlbumRobustByTitle(
    client,
    'Bahram & Ali Sorena',
    'Khoone Khorshid',
    { timeoutMs: 30, maxPages: 3 }
  );

  assert.equal(opened.route, 'artist_component_direct');
  assert.equal(opened.album.title, 'Khoone Khorshid');
  assert.deepEqual(opened.tracks.map(track => track.title), ['Track One', 'Track Two']);
});


test('bare counted rows are ignored outside declared album surfaces', () => {
  const accidental = parseMeloBotSearchSurface([{
    message: 'آهنگ های Hichkas',
    replyMarkup: {
      rows: [
        { buttons: [{ text: 'Zedbazi (23)' }] },
        { buttons: [{ text: 'Jangale Asfalt (10)' }] },
      ],
    },
  }]);
  assert.equal(accidental.albums.length, 0);

  const declared = inspectMeloBotAlbumListing([{
    message: 'آلبوم های خواننده (2) :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: 'Album One (8)' }] },
        { buttons: [{ text: 'Album Two (10)' }] },
      ],
    },
  }]);
  assert.equal(declared.confirmed, true);
  assert.deepEqual(declared.albums.map(album => album.title), ['Album One', 'Album Two']);
});

test('legacy mixed album catalog rows force a live refresh instead of a partial list', async () => {
  const originalQuery = db.query;
  db.query = async () => ({
    rowCount: 1,
    rows: [{
      name: 'Hichkas',
      data: {
        name: 'Hichkas',
        albumsUpdatedAt: new Date().toISOString(),
        albumList: [
          { title: 'Mojaz', rawText: '💿 Mojaz (14)' },
          { title: 'Zedbazi', rawText: 'Zedbazi (23)' },
        ],
      },
    }],
  });

  try {
    const store = new CatalogStore();
    const albums = await store.getAlbums('Hichkas', 7 * 24 * 60 * 60 * 1000);
    assert.equal(albums, null);
  } finally {
    db.query = originalQuery;
  }
});

test('MeloBot track pages keep lazy media actions visible but require source-backed Artist navigation', () => {
  const keyboard = trackPageKeyboard(
    'stable1',
    { source: 'melobot', artist: 'T-Dey', title: 'Khalesaneh' },
    { media: {} },
    {}
  );
  const texts = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.ok(texts.includes('📥 کیفیت عالی'));
  assert.ok(texts.includes('📥 کیفیت معمولی'));
  assert.ok(texts.includes('📝 متن'));
  assert.ok(texts.includes('🖼 کاور'));
  assert.ok(texts.includes('📋 مشخصات'));
  assert.equal(texts.includes('🗣 صفحه‌ی خواننده'), false);
});

test('inferred page-context artists are not presented as confirmed primary artists', () => {
  const inferred = parseTrackButton('🎵 Khalesaneh (feat. T-Dey)', 'T-Dey');
  assert.equal(inferred.artistInferred, true);
  assert.equal(trackPageTitle(inferred), 'Khalesaneh (feat. T-Dey)');
  assert.equal(
    trackButtonLabel(inferred, 0).includes('T-Dey —'),
    false
  );
});

test('inferred featured-artist rows resolve to the explicit primary artist by title', async () => {
  const inferred = {
    ...parseTrackButton('🎵 Khalesaneh (feat. T-Dey)', 'T-Dey'),
    source: 'melobot',
  };
  const client = new FakeTelegramClient({
    'Khalesaneh (feat. T-Dey)': [[
      fakeBotMessage(
        'نتیجه جستجو',
        ['🎵 Sadegh, Khalesaneh (feat. T-Dey) x 1.2M']
      ),
    ]],
  });

  const resolved = await resolveMeloBotTrackCandidate(
    client,
    inferred,
    { timeoutMs: 100, forceIdentity: true }
  );
  assert.equal(resolved.artist, 'Sadegh');
  assert.equal(resolved.title, 'Khalesaneh (feat. T-Dey)');
  assert.equal(resolved.artistInferred, false);
});

test('complex collaboration query ranks full token coverage above one-token artist matches', () => {
  assert.deepEqual(
    meaningfulSearchTokens('Shayea Ma Ft T-Dey'),
    ['shayea', 'ma', 'dey']
  );

  const ranked = rankTracksForQuery('Shayea Ma Ft T-Dey', [
    { artist: 'T-Dey', title: 'Ghorooha' },
    { artist: 'T-Dey', title: 'Ye Ja Dige' },
    { artist: 'Shayea', title: 'Ma (Ft T-Dey)' },
  ]);

  assert.equal(ranked[0].track.artist, 'Shayea');
  assert.equal(ranked[0].track.title, 'Ma (Ft T-Dey)');
  assert.equal(ranked[0].coverage, 3);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('derived artist lists use release date for recent and popularity for top', async () => {
  const originalQuery = db.query;
  const sqlCalls = [];
  db.query = async (sql) => {
    sqlCalls.push(String(sql));
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    await catalog.deriveArtistList('Haamim', 'recent', 10);
    await catalog.deriveArtistList('Haamim', 'top', 10);
  } finally {
    db.query = originalQuery;
  }

  assert.match(sqlCalls[0], /release_date IS NOT NULL/i);
  assert.match(sqlCalls[0], /release_date DESC/i);
  assert.match(sqlCalls[1], /popularity_count IS NOT NULL/i);
  assert.match(sqlCalls[1], /popularity_count DESC/i);
});

test('query relevance matrix covers artist title collaboration and Persian album intent', () => {
  const cases = [
    {
      query: 'reza bahram',
      tracks: [
        { artist: 'Bahram', title: '24 Saat' },
        { artist: 'Reza Bahram', title: 'Gole Eshgh' },
      ],
      expected: 'Gole Eshgh',
    },
    {
      query: 'hichkas mojaz',
      tracks: [
        { artist: 'Hichkas', title: 'Ye Rooze Khoob Miad' },
        { artist: 'Hichkas', title: 'Mojaz' },
      ],
      expected: 'Mojaz',
    },
    {
      query: 'Sadegh Khalesaneh T-Dey',
      tracks: [
        { artist: 'T-Dey', title: 'Alaghe' },
        { artist: 'Sadegh', title: 'Khalesaneh (feat. T-Dey)' },
      ],
      expected: 'Khalesaneh (feat. T-Dey)',
    },
    {
      query: 'هیچکس یه روز خوب میاد',
      tracks: [
        { artist: 'هیچکس', title: 'اختلاف' },
        { artist: 'هیچکس', title: 'یه روز خوب میاد' },
      ],
      expected: 'یه روز خوب میاد',
    },
  ];

  for (const item of cases) {
    const ranked = rankTracksForQuery(item.query, item.tracks);
    assert.equal(ranked[0].track.title, item.expected, item.query);
  }

  assert.equal(hasAlbumIntent('آلبوم‌های هیچکس'), true);
  assert.equal(hasAlbumIntent('البوم های شایع'), true);
});


test('track-specific collaboration queries do not offer a misleading dominant Artist shortcut', () => {
  const keyboard = resultsKeyboard('rel1', {
    query: 'Shayea Ma Ft T-Dey',
    options: [
      { source: 'melobot', artist: 'T-Dey', title: 'Ghorooha' },
      { source: 'melobot', artist: 'T-Dey', title: 'Ye Ja Dige' },
      { source: 'melobot', artist: 'Shayea', title: 'Ma (Ft T-Dey)' },
    ],
    albumOptions: [],
  });
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.some(value => value?.startsWith('ar:')), false);
});

test('artist-only partial-name queries still offer the matching Artist shortcut', () => {
  const keyboard = resultsKeyboard('rel2', {
    query: 'bahram',
    options: [
      { source: 'melobot', artist: 'Reza Bahram', title: 'Gole Eshgh' },
      { source: 'melobot', artist: 'Reza Bahram', title: 'Hamsafar' },
    ],
    albumOptions: [],
  });
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.includes('ar:rel2:0'), true);
});

test('explicit album intent can still offer the unique album Artist shortcut', () => {
  const keyboard = resultsKeyboard('rel3', {
    query: 'آلبوم های هیچکس',
    options: [],
    albumOptions: [
      { source: 'melobot', artist: 'Hichkas', title: 'Mojaz' },
    ],
  });
  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.includes('aar:rel3:0'), true);
});

test('source-verified track-looking albums survive catalog trust filtering', async () => {
  const originalQuery = db.query;
  db.query = async () => ({
    rowCount: 1,
    rows: [{
      name: 'Hichkas',
      data: {
        name: 'Hichkas',
        albumsUpdatedAt: new Date().toISOString(),
        albumList: [{
          title: 'Mojaz',
          rawText: '🎵 Hichkas, Mojaz',
          verifiedAlbum: true,
          albumTrustVersion: 2,
        }],
      },
    }],
  });

  try {
    const store = new CatalogStore();
    const albums = await store.getAlbums('Hichkas', 7 * 24 * 60 * 60 * 1000);
    assert.equal(albums.length, 1);
    assert.equal(albums[0].title, 'Mojaz');
  } finally {
    db.query = originalQuery;
  }
});


test('capability persistence stores positive evidence only and treats false as unknown', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes('INSERT INTO deep_tracks')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  try {
    const catalog = new DeepCatalog();
    await catalog.setCapabilities(
      { artist: 'A', title: 'One', source: 'melobot' },
      {
        hasHq: true,
        hasNormal: false,
        hasLyrics: false,
        hasCover: true,
      }
    );
  } finally {
    db.query = originalQuery;
  }

  const update = calls.find(call => call.sql.includes('capabilitiesCheckedAt'));
  assert.ok(update);
  const stored = JSON.parse(update.params[1]);
  assert.deepEqual(stored, { hasHq: true, hasCover: true });
  assert.equal('hasNormal' in stored, false);
  assert.equal('hasLyrics' in stored, false);
});


test('failed canonical lookup keeps an inferred artist unconfirmed', async () => {
  const inferred = {
    ...parseTrackButton('🎵 Khalesaneh (feat. T-Dey)', 'T-Dey'),
    source: 'melobot',
  };
  const client = new FakeTelegramClient({
    'Khalesaneh (feat. T-Dey)': [[fakeBotMessage('no result', [])]],
    'T-Dey Khalesaneh (feat. T-Dey)': [[fakeBotMessage('no result', [])]],
  });

  const resolved = await resolveMeloBotTrackCandidate(
    client,
    inferred,
    { timeoutMs: 30, forceIdentity: true }
  );

  assert.equal(resolved.artist, 'T-Dey');
  assert.equal(resolved.artistInferred, true);
});


test('confirmed album-list rows carry verified provenance, including bare counted rows', () => {
  const listing = inspectMeloBotAlbumListing([{
    message: 'آلبوم های خواننده (2) :',
    replyMarkup: {
      rows: [
        { buttons: [{ text: 'Mojaz (14)' }] },
        { buttons: [{ text: 'Jangale Asfalt (10)' }] },
      ],
    },
  }]);

  assert.equal(listing.confirmed, true);
  assert.equal(listing.albums.length, 2);
  assert.ok(listing.albums.every(album => album.verifiedAlbum === true));
});

test('legacy album rows without raw source provenance force a live refresh', async () => {
  const originalQuery = db.query;
  db.query = async () => ({
    rowCount: 1,
    rows: [{
      name: 'Legacy Artist',
      data: {
        name: 'Legacy Artist',
        albumsUpdatedAt: new Date().toISOString(),
        albumList: [{ title: 'Mystery Album' }],
      },
    }],
  });

  try {
    const store = new CatalogStore();
    const albums = await store.getAlbums(
      'Legacy Artist',
      7 * 24 * 60 * 60 * 1000
    );
    assert.equal(albums, null);
  } finally {
    db.query = originalQuery;
  }
});

test('direct track-menu cover button works without requiring a More submenu', async () => {
  const raw = '🎵 Artist, Direct Cover';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage('track', ['کیفیت عالی', 'کاور']),
    ]],
    'کاور': [[{
      message: '',
      media: { photo: { id: 'photo-1' } },
    }]],
  });

  const cover = await getMeloBotCover(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 1200 }
  );

  assert.ok(cover?.photoMessage);
  assert.deepEqual(client.sent, [raw, 'کاور']);
});

test('direct track-menu metadata button works without requiring a More submenu', async () => {
  const raw = '🎵 Artist, Direct Info';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage('track', ['کیفیت عالی', 'مشخصات']),
    ]],
    'مشخصات': [[
      fakeBotMessage('2026-09-20\n📥: 1.2M', []),
    ]],
  });

  const metadata = await getMeloBotTrackMetadata(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 1200 }
  );

  assert.equal(metadata.releaseDate, '2026-09-20');
  assert.equal(metadata.popularityCount, 1200000);
  assert.deepEqual(client.sent, [raw, 'مشخصات']);
});

test('exact artist query prefers Bahram over Reza Bahram in Artist shortcut', () => {
  const keyboard = resultsKeyboard('bahram1', {
    query: 'bahram',
    options: [
      { source: 'melobot', artist: 'Reza Bahram', title: 'Hamsafar' },
      { source: 'melobot', artist: 'Reza Bahram', title: 'Yar' },
      { source: 'melobot', artist: 'Bahram', title: '24 Saat' },
    ],
    albumOptions: [],
  });

  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(callbacks.includes('ar:bahram1:2'));
});

test('ambiguous partial artist query does not invent a single Artist shortcut', () => {
  const keyboard = resultsKeyboard('amb1', {
    query: 'ali',
    options: [
      { source: 'melobot', artist: 'Ali Sorena', title: 'One' },
      { source: 'melobot', artist: 'Ali Yasini', title: 'Two' },
    ],
    albumOptions: [],
  });

  const callbacks = keyboard.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(callbacks.some(value => value?.startsWith('ar:amb1:')), false);
});

test('persistent Artist lists drop inferred featured rows but keep canonical rows', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [], rowCount: 1 };
  };

  try {
    const catalog = new DeepCatalog();
    await catalog.setArtistList('T-Dey', 'recent', [
      {
        artist: 'T-Dey',
        title: 'Khalesaneh (feat. T-Dey)',
        artistInferred: true,
        source: 'melobot',
      },
      {
        artist: 'T-Dey',
        title: 'Real T-Dey Track',
        source: 'melobot',
      },
    ]);
  } finally {
    db.query = originalQuery;
  }

  const trackWrites = calls.filter(call =>
    call.sql.includes('INSERT INTO deep_tracks')
  );
  assert.equal(trackWrites.length, 1);
  assert.equal(trackWrites[0].params[2], 'Real T-Dey Track');
});

test('derived Artist lists exclude rows without the ranking evidence they claim', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    await catalog.deriveArtistList('Haamim', 'recent', 10);
    await catalog.deriveArtistList('Haamim', 'top', 10);
  } finally {
    db.query = originalQuery;
  }

  assert.match(calls[0].sql, /release_date IS NOT NULL/i);
  assert.match(calls[1].sql, /popularity_count IS NOT NULL/i);
});

test('quality download gives confirmed media delivery its own bounded stage', async () => {
  const raw = '🎵 Artist, Slow Quality';
  const client = new FakeTelegramClient({
    [raw]: [[fakeBotMessage('track', ['کیفیت عالی'])]],
    'کیفیت عالی': [[]],
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => downloadMeloBotTrackQuality(
      client,
      { ...parseTrackButton(raw), source: 'melobot' },
      'hq',
      {
        timeoutMs: 600,
        menuTimeoutMs: 300,
        deliveryTimeoutMs: 120,
      }
    ),
    err => err?.code === 'MELOBOT_DELIVERY_TIMEOUT'
  );
  assert.ok(Date.now() - startedAt < 1500);
});


test('fresh MeloBot album evidence carries the current trust version', () => {
  const listing = inspectMeloBotAlbumListing([
    fakeBotMessage('آلبوم های خواننده (1) :', ['💿 Mojaz (14)']),
  ]);
  assert.equal(listing.albums.length, 1);
  assert.equal(listing.albums[0].verifiedAlbum, true);
  assert.equal(listing.albums[0].albumTrustVersion, 2);

  const search = parseMeloBotSearchSurface([
    fakeBotMessage('search', ['💿 Hichkas, Mojaz']),
  ]);
  assert.equal(search.albums.length, 1);
  assert.equal(search.albums[0].verifiedAlbum, true);
  assert.equal(search.albums[0].albumTrustVersion, 2);
});

test('legacy album rows are invalidated even when they previously looked verified', async () => {
  const store = new CatalogStore();
  const now = new Date().toISOString();

  store.readArtist = async () => ({
    key: 'hichkas',
    node: {
      name: 'Hichkas',
      albumsUpdatedAt: now,
      albumList: [{
        title: 'Zedbazi',
        rawText: '💿 Zedbazi (23)',
        verifiedAlbum: true,
      }],
    },
  });

  assert.equal(await store.getAlbums('Hichkas', 60_000), null);

  store.readArtist = async () => ({
    key: 'hichkas',
    node: {
      name: 'Hichkas',
      albumsUpdatedAt: now,
      albumList: [{
        title: 'Mojaz',
        rawText: '💿 Mojaz (14)',
        verifiedAlbum: true,
        albumTrustVersion: 2,
      }],
    },
  });

  const trusted = await store.getAlbums('Hichkas', 60_000);
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].title, 'Mojaz');
});

test('deep Artist lists ignore pre-v1.5.8 relation rows', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    const tracks = await catalog.getArtistList('Haamim', 'recent', 10);
    assert.deepEqual(tracks, []);
  } finally {
    db.query = originalQuery;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /list_version\s*>=\s*1/i);
});

test('track pages never expose Artist navigation for an inferred primary artist', () => {
  const keyboard = trackPageKeyboard(
    'infer1',
    {
      source: 'melobot',
      artist: 'T-Dey',
      title: 'Khalesaneh (feat. T-Dey)',
      artistInferred: true,
    },
    { media: {}, metadata: {} },
    { hasArtistPage: true }
  );

  const callbacks = keyboard.inline_keyboard
    .flat()
    .map(button => button.callback_data);

  assert.equal(callbacks.includes('tar:infer1'), false);
  assert.equal(callbacks.includes('tqh:infer1'), true);
  assert.equal(callbacks.includes('tqn:infer1'), true);
  assert.equal(callbacks.includes('tcv:infer1'), true);
  assert.equal(callbacks.includes('tly:infer1'), true);
});


test('query normalization unifies Persian Arabic digits and keyboard variants', () => {
  assert.equal(normalizeText('بهرام ۲۴ ساعت'), 'بهرام 24 ساعت');
  assert.equal(normalizeText('بهرام ٢٤ ساعت'), 'بهرام 24 ساعت');
  assert.equal(normalizeText('علي كريمي'), 'علی کریمی');
  assert.equal(normalizeText('آلبوم‌های شایع'), 'آلبوم های شایع');
});

test('query ranking prefers full collaboration coverage over a featured-artist-only hit', () => {
  const ranked = rankTracksForQuery(
    'Shayea Ma Ft T-Dey',
    [
      { artist: 'T-Dey', title: 'Ye Ja Dige' },
      { artist: 'Sadegh', title: 'Khalesaneh (feat. T-Dey)' },
      { artist: 'Shayea', title: 'Ma (Ft T-Dey)' },
    ]
  );

  assert.equal(ranked[0].track.artist, 'Shayea');
  assert.equal(ranked[0].track.title, 'Ma (Ft T-Dey)');
  assert.ok(ranked[0].coverage > ranked[1].coverage);
});


test('legacy JSON Artist lists are ignored until rewritten with current semantics', async () => {
  const store = new CatalogStore();
  const now = new Date().toISOString();
  const canonicalTrack = { artist: 'Haamim', title: 'Track One', source: 'melobot' };

  store.readArtist = async () => ({
    key: 'haamim',
    node: {
      name: 'Haamim',
      artistUpdatedAt: now,
      topTracks: [canonicalTrack],
      recentTracks: [],
    },
  });
  assert.equal(await store.getArtistContext('Haamim', 60_000), null);

  store.readArtist = async () => ({
    key: 'haamim',
    node: {
      name: 'Haamim',
      artistListVersion: 1,
      topTracksVersion: 1,
      artistUpdatedAt: now,
      topTracks: [canonicalTrack],
      recentTracks: [],
    },
  });
  const current = await store.getArtistContext('Haamim', 60_000);
  assert.equal(current.artist, 'Haamim');
  assert.equal(current.topTracks.length, 1);
});

test('legacy JSON album tracklists are ignored until rebuilt', async () => {
  const store = new CatalogStore();
  const now = new Date().toISOString();

  store.readArtist = async () => ({
    key: 'hichkas',
    node: {
      albums: {
        mojaz: {
          title: 'Mojaz',
          updatedAt: now,
          tracks: [{ artist: 'Hichkas', title: 'Ye Rooze Khoob' }],
        },
      },
    },
  });
  assert.equal(await store.getAlbumTracks('Hichkas', 'Mojaz', 60_000), null);

  store.readArtist = async () => ({
    key: 'hichkas',
    node: {
      albums: {
        mojaz: {
          title: 'Mojaz',
          trackListVersion: 1,
          updatedAt: now,
          tracks: [{ artist: 'Hichkas', title: 'Ye Rooze Khoob' }],
        },
      },
    },
  });
  const tracks = await store.getAlbumTracks('Hichkas', 'Mojaz', 60_000);
  assert.equal(tracks.length, 1);
});

test('deep album track reads require a rebuilt track-list provenance marker', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    const tracks = await catalog.getAlbumTracksByKey('hichkas|mojaz');
    assert.deepEqual(tracks, []);
  } finally {
    db.query = originalQuery;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /trackListVersion/);
});

test('deep album track replacement marks provenance only after replacing rows', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes('INSERT INTO deep_tracks')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  try {
    const catalog = new DeepCatalog();
    // Avoid coupling the test to upsertAlbum SQL details; exercise the
    // replacement/provenance sequence directly through the public method.
    await catalog.setAlbumTracks(
      'Hichkas',
      { title: 'Mojaz', verifiedAlbum: true, albumTrustVersion: 2 },
      [{ artist: 'Hichkas', title: 'Ye Rooze Khoob', source: 'melobot' }]
    );
  } finally {
    db.query = originalQuery;
  }

  const deleteIndex = calls.findIndex(call => call.sql.includes('DELETE FROM deep_album_tracks'));
  const markIndex = calls.findIndex(call => call.sql.includes('"trackListVersion":1'));
  assert.ok(deleteIndex >= 0);
  assert.ok(markIndex > deleteIndex);
});


test('deep album relations stay untrusted when any track artist is inferred', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes('INSERT INTO deep_tracks')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  try {
    const catalog = new DeepCatalog();
    await catalog.setAlbumTracks(
      'T-Dey',
      {
        title: 'Example Album',
        verifiedAlbum: true,
        albumTrustVersion: 2,
      },
      [
        {
          artist: 'T-Dey',
          title: 'Khalesaneh (feat. T-Dey)',
          artistInferred: true,
          source: 'melobot',
        },
      ]
    );
  } finally {
    db.query = originalQuery;
  }

  assert.equal(
    calls.some(call => call.sql.includes('INSERT INTO deep_album_tracks')),
    false
  );
  assert.equal(
    calls.some(call =>
      call.sql.includes('metadata = metadata ||') && call.sql.includes('trackListVersion')
    ),
    false
  );
  assert.equal(
    calls.some(call =>
      call.sql.includes("metadata = metadata - 'trackListVersion'")
    ),
    true
  );
});

test('track details expose an album only through current album and track-list provenance', async () => {
  const originalQuery = db.query;
  const calls = [];
  let n = 0;
  db.query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    n += 1;
    if (text.includes('FROM deep_tracks') && !text.includes('deep_album_tracks')) {
      return { rows: [{ track_key: 'a|one', artist: 'A', title: 'One', metadata: {} }] };
    }
    return { rows: [] };
  };

  try {
    const catalog = new DeepCatalog();
    const details = await catalog.getTrackDetails({ artist: 'A', title: 'One' });
    assert.equal(details.albumInfo, null);
  } finally {
    db.query = originalQuery;
  }

  const albumSql = calls.find(call => call.sql.includes('FROM deep_album_tracks'))?.sql || '';
  assert.match(albumSql, /albumTrustVersion/);
  assert.match(albumSql, /trackListVersion/);
});


test('album declarations never authorize counted buttons from another response message', () => {
  const listing = inspectMeloBotAlbumListing([
    fakeBotMessage('آلبوم های خواننده (1) :', ['💿 Mojaz (14)']),
    fakeBotMessage('خواننده های مرتبط', ['Zedbazi (23)', 'Bahram (18)']),
  ]);

  assert.deepEqual(listing.albums.map(album => album.title), ['Mojaz']);
  assert.equal(listing.declaredCount, 1);
  assert.equal(listing.complete, true);
});

test('lyrics button with an empty response is unknown rather than confirmed unavailable', async () => {
  const raw = '🎵 Artist, Song';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage('track menu', ['کیفیت عالی', 'متن آهنگ'])
    ]],
    'متن آهنگ': [[]],
  });

  await assert.rejects(
    () => getMeloBotLyrics(
      client,
      { ...parseTrackButton(raw), source: 'melobot' },
      { timeoutMs: 40 }
    ),
    /lyrics response was empty/i
  );
});

test('missing Lyrics button is a confirmed unavailable result', async () => {
  const raw = '🎵 Artist, Song';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage('track menu', ['کیفیت عالی', 'کیفیت معمولی'])
    ]],
  });

  const result = await getMeloBotLyrics(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 40 }
  );
  assert.equal(result.available, false);
  assert.equal(result.checked, true);
});


test('refreshing only recent Artist tracks never blesses a legacy top list', async () => {
  const store = new CatalogStore();
  const writes = [];
  store.readArtist = async () => ({
    key: 'haamim',
    node: {
      name: 'Haamim',
      topTracks: [{ artist: 'Wrong Artist', title: 'Legacy Wrong' }],
      recentTracks: [],
    },
  });
  store.writeArtist = async (_key, node) => {
    writes.push(structuredClone(node));
  };
  store.seedArtistsFromTracks = async () => {};

  await store.recordArtist('Haamim', {
    topTracks: [],
    recentTracks: [{ artist: 'Haamim', title: 'Fresh Recent', source: 'melobot' }],
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].topTracksVersion, undefined);
  assert.equal(writes[0].recentTracksVersion, 1);

  store.readArtist = async () => ({
    key: 'haamim',
    node: {
      ...writes[0],
      artistUpdatedAt: new Date().toISOString(),
    },
  });
  const context = await store.getArtistContext('Haamim', 60_000);
  assert.deepEqual(context.topTracks, []);
  assert.deepEqual(context.recentTracks.map(track => track.title), ['Fresh Recent']);
});


test('two-token partial search coverage triggers relevance fallback', () => {
  assert.equal(shouldUseSearchRelevanceFallback('Sadegh Khalesaneh', 1), true);
  assert.equal(shouldUseSearchRelevanceFallback('Reza Bahram', 2), false);
  assert.equal(shouldUseSearchRelevanceFallback('Hichkas', 0), false);
});

test('lyrics action can find the lyrics button behind a More submenu', async () => {
  const raw = '🎵 Artist, Hidden Lyrics';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage(
        'track menu',
        ['کیفیت عالی', 'کیفیت معمولی', 'بیشتر']
      ),
    ]],
    'بیشتر': [[
      fakeBotMessage('more menu', ['متن آهنگ', 'کاور'])
    ]],
    'متن آهنگ': [[
      fakeBotMessage('line one\nline two\n@MeloBot', [])
    ]],
  });

  const result = await getMeloBotLyrics(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 1200 }
  );

  assert.equal(result.available, true);
  assert.equal(result.text, 'line one\nline two');
  assert.deepEqual(client.sent, [raw, 'بیشتر', 'متن آهنگ']);
});

test('track metadata reuses release date already visible on the track menu', async () => {
  const raw = '🎵 Artist, Menu Metadata x 1.2M';
  const client = new FakeTelegramClient({
    [raw]: [[
      {
        ...fakeBotMessage(
          'Released: 2024-05-06\n📥 1.2M',
          ['کیفیت عالی', 'کیفیت معمولی']
        ),
      },
    ]],
  });

  const metadata = await getMeloBotTrackMetadata(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 1200 }
  );

  assert.equal(metadata.releaseDate, '2024-05-06');
  assert.equal(metadata.popularityCount, 1_200_000);
});


test('empty More response keeps lyrics availability unknown instead of caching a false negative', async () => {
  const raw = '🎵 Artist, Unknown Lyrics';
  const client = new FakeTelegramClient({
    [raw]: [[
      fakeBotMessage('track menu', ['کیفیت عالی', 'بیشتر']),
    ]],
    'بیشتر': [[]],
  });

  await assert.rejects(
    () => getMeloBotLyrics(
      client,
      { ...parseTrackButton(raw), source: 'melobot' },
      { timeoutMs: 120 }
    ),
    /submenu returned no response|budget exhausted/
  );
});

test('bundled enrichment discovers lyrics hidden behind More before declaring them unavailable', async () => {
  const raw = '🎵 Artist, Bundled Hidden Lyrics';
  const client = new FakeTelegramClient({
    [raw]: [
      [fakeBotMessage('track menu', ['کیفیت عالی', 'کیفیت معمولی', 'بیشتر'])],
    ],
    'بیشتر': [[
      fakeBotMessage('more menu', ['متن آهنگ'])
    ]],
    'متن آهنگ': [[
      fakeBotMessage('first line\nsecond line\n@MeloBot', [])
    ]],
  });

  const bundle = await enrichMeloBotTrack(
    client,
    { ...parseTrackButton(raw), source: 'melobot' },
    { timeoutMs: 1600 }
  );

  assert.equal(bundle.capabilities.hasLyrics, true);
  assert.equal(bundle.lyrics.available, true);
  assert.equal(bundle.lyrics.checked, true);
  assert.equal(bundle.lyrics.text, 'first line\nsecond line');
});


test('composite artist separator guard catches collaboration-style credits conservatively', () => {
  assert.equal(hasCompositeArtistSeparators('Drake & Yeat'), true);
  assert.equal(hasCompositeArtistSeparators('Eminem x Jay Z'), true);
  assert.equal(hasCompositeArtistSeparators('Sadegh feat. T-Dey'), true);
  assert.equal(hasCompositeArtistSeparators('Feid, Pirlo'), true);
  assert.equal(hasCompositeArtistSeparators('H.E.R.'), false);
  assert.equal(hasCompositeArtistSeparators('Reza Jafari'), false);
});


test('tri-state track UI hides a quality after the current session confirms failure', () => {
  const keyboard = trackPageKeyboard(
    'tri1',
    { source: 'melobot', artist: 'Reza Bahram', title: 'Yar', rawText: '🎵 Reza Bahram, Yar' },
    { media: {}, metadata: {} },
    {
      hasHq: true,
      hasNormal: false,
      hasLyrics: null,
      hasCover: null,
      hasMetadata: null,
      hasArtistPage: true,
    }
  );
  const texts = keyboard.inline_keyboard.flat().map(button => button.text);
  assert.ok(texts.includes('📥 کیفیت عالی'));
  assert.equal(texts.includes('📥 کیفیت معمولی'), false);
  assert.ok(texts.includes('🗣 صفحه‌ی خواننده'));
});

test('deep catalog learns Persian-to-Latin track alias from cached Telegram audio metadata', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });

    if (text.includes('FROM track_aliases a')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM track_cache') && text.includes('ORDER BY updated_at DESC')) {
      return {
        rows: [{
          track: { source: 'ahangify' },
          media: { performer: 'Reza Bahram', title: 'Yar' },
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM deep_tracks') && text.includes('WHERE track_key = $1') && text.includes('source_data')) {
      return {
        rows: [{
          artist: 'Reza Bahram',
          title: 'Yar',
          source_data: {
            source: 'melobot',
            rawText: '🎵 Reza Bahram, Yar',
          },
          duration_seconds: 214,
          popularity_count: 1200000,
          popularity_text: '1.2M',
        }],
        rowCount: 1,
      };
    }
    if (text.startsWith('SELECT 1 FROM deep_tracks')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO track_aliases')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL in alias regression: ' + text.slice(0, 120));
  };

  try {
    const catalog = new DeepCatalog();
    const resolved = await catalog.resolveTrackAlias({
      artist: 'رضا بهرام',
      title: 'یار',
      source: 'ahangify',
      cmd: '/dl_BD69WA3',
    });

    assert.equal(resolved.artist, 'Reza Bahram');
    assert.equal(resolved.title, 'Yar');
    assert.equal(resolved.source, 'melobot');
    assert.equal(resolved.rawText, '🎵 Reza Bahram, Yar');
    assert.equal(resolved.cmd, '/dl_BD69WA3');

    const aliasInsert = calls.find(call => call.sql.includes('INSERT INTO track_aliases'));
    assert.ok(aliasInsert);
    assert.equal(aliasInsert.params[0], 'رضا بهرام|یار');
    assert.equal(aliasInsert.params[3], 'reza bahram|yar');
    assert.equal(aliasInsert.params[5], 'telegram_audio_metadata');
  } finally {
    db.query = originalQuery;
  }
});


test('ranked MeloBot feed rows do not manufacture numbered artists', () => {
  const parsed = parseTrackButton('#49 🎵 Hamed Rustaie, Mojezeh x 10k');
  assert.equal(parsed.artist, 'Hamed Rustaie');
  assert.equal(parsed.title, 'Mojezeh');
  assert.equal(parsed.sourcePopularityCount, 10000);
});

test('file cache keys ignore changing feed rank prefixes', () => {
  const ranked = trackCacheKey({
    artist: 'Hayedeh',
    title: 'Soghati',
    rawText: '#29 🎵 Hayedeh, Soghati x 39.7k',
  });
  const unranked = trackCacheKey({
    artist: 'Hayedeh',
    title: 'Soghati',
    rawText: '🎵 Hayedeh, Soghati x 39.7k',
  });
  assert.equal(ranked, unranked);
  assert.equal(ranked, 'hayedeh|soghati|hayedeh soghati');
});

test('full-coverage search filtering removes partial false positives when an exact match exists', () => {
  const tracks = keepFullCoverageTracksWhenAvailable('رضا بهرام یار', [
    { artist: 'رضا بهرام', title: 'یار', source: 'ahangify' },
    { artist: 'Reza Sadeghi', title: 'Bemoni Baram' },
    { artist: 'Reza Bahram', title: 'Hamdam' },
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].artist, 'رضا بهرام');
  assert.equal(tracks[0].title, 'یار');
});

test('legacy trustworthy Artist lists self-heal their semantic version locally', async () => {
  const originalQuery = db.query;
  const calls = [];
  const now = new Date().toISOString();
  db.query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes('SELECT name, data FROM artists')) {
      return {
        rows: [{
          name: 'Reza Bahram',
          data: {
            name: 'Reza Bahram',
            artistUpdatedAt: now,
            topTracks: [
              { artist: 'Reza Bahram', title: 'Yar', source: 'melobot', rawText: '🎵 Reza Bahram, Yar' },
              { artist: 'Reza Bahram', title: 'Hamdam', source: 'melobot', rawText: '🎵 Reza Bahram, Hamdam' },
            ],
            recentTracks: [],
          },
        }],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO artists')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL in Artist self-heal regression: ' + text.slice(0, 120));
  };

  try {
    const store = new CatalogStore();
    const context = await store.getArtistContext('Reza Bahram', 72 * 60 * 60 * 1000);
    assert.equal(context.healedLegacyLists, true);
    assert.equal(context.topTracks.length, 2);
    const write = calls.find(call => call.sql.includes('INSERT INTO artists'));
    assert.ok(write);
    const stored = JSON.parse(write.params[2]);
    assert.equal(stored.topTracksVersion, 1);
    assert.equal(stored.artistListVersion, 1);
  } finally {
    db.query = originalQuery;
  }
});


test('Artist picker matches icon labeled buttons', () => {
  const messages = [fakeBotMessage('results', ['🗣 Ali Yasini'])];
  assert.equal(findArtistButtonFor(messages, 'Ali Yasini'), '🗣 Ali Yasini');
});


test('explicit Track resolver rejects unrelated search results', async () => {
  const row = '🎵 Ehaam, Boghze Modaam x 335.9k';
  const client = new FakeTelegramClient({
    'Xaniar Shabe Mahtab (feat. Ehaam)': [[fakeBotMessage('results', [row])]],
    'Shabe Mahtab (feat. Ehaam)': [[fakeBotMessage('results', [row])]],
  });
  await assert.rejects(
    () => resolveMeloBotTrackCandidate(client, {
      source: 'melobot', artist: 'Xaniar', title: 'Shabe Mahtab (feat. Ehaam)',
      rawText: '🎬🎵 Xaniar, Shabe Mahtab (feat. Ehaam)', sourceStateVersion: 1,
    }, { timeoutMs: 1200 }),
    err => err?.code === 'MELOBOT_TRACK_RESOLVE_FAILED'
  );
});
