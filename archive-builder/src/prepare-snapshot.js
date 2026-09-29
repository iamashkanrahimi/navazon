import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { BASELINE_COUNT, USER_SNAPSHOT_SHA256 } from './snapshot.js';
import { sha256 } from './utils.js';

const gzip = promisify(zlib.gzip);
const url = process.env.RJ_SITEMAP_URL || 'https://www.radiojavan.com/sitemap.xml';
const outDir = path.resolve(process.env.RJ_RUNTIME_DIR || './runtime');
await fs.mkdir(outDir, { recursive: true });

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
let response;
try {
  response = await fetch(url, { headers: { 'User-Agent': 'NavazonArchiveBuilder/0.5 snapshot-prep' }, signal: controller.signal, redirect: 'follow' });
} finally { clearTimeout(timer); }
if (!response.ok) throw new Error(`Sitemap HTTP ${response.status}`);
const xml = await response.text();
const originalHash = sha256(xml);
const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1]
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim());
const songs = [];
const seen = new Set();
for (const value of locs) {
  if (!/^https:\/\/www\.radiojavan\.com\/mp3s\/mp3\//i.test(value)) continue;
  if (seen.has(value)) continue;
  seen.add(value); songs.push(value);
}
if (songs.length < 25_000 || songs.length > 50_000) throw new Error(`Unexpected song URL count: ${songs.length}`);
const delta = songs.length - BASELINE_COUNT;
if (Math.abs(delta) > 1500) throw new Error(`Snapshot count drift too large: ${songs.length} vs baseline ${BASELINE_COUNT}`);
const gz = await gzip(Buffer.from(`${songs.join('\n')}\n`, 'utf8'), { level: 9 });
const gzPath = path.join(outDir, 'song-urls.txt.gz');
await fs.writeFile(gzPath, gz);
const manifest = {
  created_at: new Date().toISOString(),
  sitemap_url: url,
  sitemap_sha256: originalHash,
  previous_user_snapshot_sha256: USER_SNAPSHOT_SHA256,
  baseline_song_count: BASELINE_COUNT,
  song_count: songs.length,
  delta_from_baseline: delta,
  song_urls_gzip_sha256: sha256(gz),
  first_url: songs[0],
  last_url: songs.at(-1),
};
await fs.writeFile(path.join(outDir, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
