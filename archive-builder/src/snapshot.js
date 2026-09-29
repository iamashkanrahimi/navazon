import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { sha256 } from './utils.js';

const gunzip = promisify(zlib.gunzip);
export const BASELINE_COUNT = 32739;
export const USER_SNAPSHOT_SHA256 = '5619481e67b0c326acb9398a4c15211d790edd67242ad63d264ae4a4fc881a41';

export async function loadSnapshot(file = process.env.RJ_SNAPSHOT_FILE || './runtime/song-urls.txt.gz') {
  const bytes = await fs.readFile(file);
  const text = (await gunzip(bytes)).toString('utf8');
  const urls = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (new Set(urls).size !== urls.length) throw new Error('Snapshot contains duplicate URLs');
  if (!urls.length) throw new Error('Snapshot is empty');
  return { urls, gzip_sha256: sha256(bytes) };
}

export function shardUrls(urls, shardIndex, shardCount) {
  if (!(shardCount > 0) || shardIndex < 0 || shardIndex >= shardCount) throw new Error('Invalid shard');
  return urls.filter((_, index) => index % shardCount === shardIndex);
}

function addFirstMatching(urls, out, seen, predicate) {
  const index = urls.findIndex((url, i) => !seen.has(i) && predicate(url, i));
  if (index < 0) return;
  seen.add(index);
  out.push(urls[index]);
}

export function selectPilotUrls(urls, limit = 50) {
  const out = [];
  const seen = new Set();
  const addIndex = index => {
    if (index < 0 || index >= urls.length || seen.has(index)) return;
    seen.add(index); out.push(urls[index]);
  };

  for (let i = 0; i < 8; i += 1) addIndex(i);
  for (let i = 1; i <= 8; i += 1) addIndex(urls.length - i);
  addFirstMatching(urls, out, seen, u => /\(Ft-|%28Ft-|\bFt-/i.test(u));
  addFirstMatching(urls, out, seen, u => /Remix/i.test(u));
  addFirstMatching(urls, out, seen, u => /Medley/i.test(u));
  addFirstMatching(urls, out, seen, u => /[^\x00-\x7F]/.test(u));
  addFirstMatching(urls, out, seen, u => /\/mp3s\/mp3\/\d/i.test(u));
  addFirstMatching(urls, out, seen, u => (u.split('-').length - 1) >= 8);

  const remaining = Math.max(0, limit - out.length);
  for (let i = 1; i <= remaining; i += 1) addIndex(Math.floor((i * (urls.length - 1)) / (remaining + 1)));
  for (let i = 0; out.length < limit && i < urls.length; i += 1) addIndex(i);
  return out.slice(0, limit);
}
