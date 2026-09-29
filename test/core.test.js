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
} = await import('../src/sources/melobot.js');
const { parseAhangifyResults } = await import('../src/ahangify.js');
const {
  installTelegramInbox,
  latestMessageId,
  collectNewMessages,
} = await import('../src/mtproto.js');
const { SerialQueue } = await import('../src/queue.js');
const { trackCacheKey } = await import('../src/cache.js');
const { DeepCatalog, deepTrackKey } = await import('../src/deepCatalog.js');
const { db } = await import('../src/db.js');
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
  shouldUseLiveAlbumDiscovery,
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
    () => searchMeloBot(client, 'Same Artist', { maxRefinements: 5 }),
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
    { allowEmpty: true, maxAlbums: 20 }
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
    { allowEmpty: true, maxAlbums: 20 }
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
    { timeoutMs: 650, maxPages: 3 }
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
    { timeoutMs: 650, maxPages: 3 }
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

  const counted = parseAlbumButton('Album of the Year (10)');
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
