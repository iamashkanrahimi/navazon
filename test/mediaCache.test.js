import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBestPhoto } from '../src/mediaCache.js';

test('pickBestPhoto chooses largest Telegram PhotoSize', () => {
  const best = pickBestPhoto({ photo: [
    { file_id:'a', width:90, height:90, file_size:1000 },
    { file_id:'b', width:320, height:320, file_size:5000 },
    { file_id:'c', width:1000, height:1000, file_size:12000 },
  ]});
  assert.equal(best.file_id, 'c');
});
