import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const EXPECTED_COUNT = 32739;
const EXPECTED_TEXT_SHA256 = '654318e51a0608943b675f2567f9c095c64717f8c9857fabe70de2609f439c7a';
const ORIGINAL_SITEMAP_SHA256 = '5619481e67b0c326acb9398a4c15211d790edd67242ad63d264ae4a4fc881a41';

const partsDir = path.resolve('./data/snapshot-parts');
const runtimeDir = path.resolve('./runtime');
await fs.mkdir(runtimeDir, { recursive: true });

const names = (await fs.readdir(partsDir)).filter(x => /^part-\d{3}\.txt$/.test(x)).sort();
if (!names.length) throw new Error('No snapshot parts found');

const urls = [];
for (const name of names) {
  const text = await fs.readFile(path.join(partsDir, name), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    if (!/^https:\/\/www\.radiojavan\.com\/mp3s\/mp3\//i.test(url)) throw new Error(`Unexpected URL in ${name}: ${url}`);
    urls.push(url);
  }
}
if (urls.length !== EXPECTED_COUNT) throw new Error(`Expected ${EXPECTED_COUNT} URLs, got ${urls.length}`);
if (new Set(urls).size !== urls.length) throw new Error('Snapshot contains duplicate URLs');

const plain = `${urls.join('\n')}\n`;
const textHash = crypto.createHash('sha256').update(plain).digest('hex');
if (textHash !== EXPECTED_TEXT_SHA256) throw new Error(`Snapshot text hash mismatch: ${textHash}`);

const gz = zlib.gzipSync(Buffer.from(plain, 'utf8'), { level: 9, mtime: 0 });
const gzHash = crypto.createHash('sha256').update(gz).digest('hex');
await fs.writeFile(path.join(runtimeDir, 'song-urls.txt.gz'), gz);

const manifest = {
  created_at: new Date().toISOString(),
  source: 'user-provided-radiojavan-sitemap-snapshot',
  original_sitemap_sha256: ORIGINAL_SITEMAP_SHA256,
  song_count: urls.length,
  song_urls_text_sha256: textHash,
  song_urls_gzip_sha256: gzHash,
  parts: names.length,
  first_url: urls[0],
  last_url: urls.at(-1)
};
await fs.writeFile(path.join(runtimeDir, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
