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
  matchBulkAudioToTracks,
} = await import('../src/sources/melobot.js');
const { parseAhangifyResults } = await import('../src/ahangify.js');
const { trackCacheKey } = await import('../src/cache.js');
const { resultsKeyboard, albumTracksKeyboard, noAlbumsKeyboard } = await import('../src/ui.js');

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
