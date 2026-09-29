import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs } from './utils.js';

async function filesRecursive(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesRecursive(full));
    else out.push(full);
  }
  return out;
}
async function readGzipJsonl(file, onRow) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const row of rl) if (row.trim()) await onRow(JSON.parse(row));
}

const args = parseArgs();
const inDir = path.resolve(args.in || './artifacts');
const outDir = path.resolve(args.out || './out/final');
const manifestPath = path.resolve(args.manifest || './runtime/snapshot-manifest.json');
const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
const expected = Number(manifest.song_count);
await fsp.mkdir(outDir, { recursive: true });
const all = await filesRecursive(inDir);
const trackFiles = all.filter(x => /-tracks\.jsonl\.gz$/.test(x) && !/pilot-tracks/.test(x));
const failureFiles = all.filter(x => /-failures\.jsonl\.gz$/.test(x) && !/pilot-failures/.test(x));
const trackOut = zlib.createGzip({ level: 9 });
const failureOut = zlib.createGzip({ level: 9 });
trackOut.pipe(fs.createWriteStream(path.join(outDir, 'rj-tracks.jsonl.gz')));
failureOut.pipe(fs.createWriteStream(path.join(outDir, 'rj-failures.jsonl.gz')));
const seenUrls = new Set(); const sourceIds = new Map(); const canonicals = new Map();
let tracks=0,duplicateUrls=0,sourceIdCollisions=0,lyrics=0,dates=0,durations=0,albumLinks=0,failures=0;
for (const file of trackFiles.sort()) await readGzipJsonl(file, row => {
  if (seenUrls.has(row.source_url)) { duplicateUrls += 1; return; }
  seenUrls.add(row.source_url);
  if (row.source_id) {
    const previous = sourceIds.get(row.source_id);
    if (previous && previous !== row.source_url) sourceIdCollisions += 1; else sourceIds.set(row.source_id,row.source_url);
  }
  canonicals.set(row.canonical_match_key || '', (canonicals.get(row.canonical_match_key || '') || 0) + 1);
  tracks += 1; if(row.lyrics_available)lyrics+=1;if(row.release_date)dates+=1;if(row.duration_seconds!=null)durations+=1;if(row.album_title)albumLinks+=1;
  trackOut.write(`${JSON.stringify(row)}\n`);
});
for (const file of failureFiles.sort()) await readGzipJsonl(file, row => { failures+=1; failureOut.write(`${JSON.stringify(row)}\n`); });
await Promise.all([new Promise(r=>trackOut.end(r)),new Promise(r=>failureOut.end(r))]);
const summary={snapshot:manifest,expected_snapshot_tracks:expected,track_files:trackFiles.length,failure_files:failureFiles.length,unique_tracks:tracks,failures,accounted_for:tracks+failures,missing_from_snapshot:Math.max(0,expected-tracks-failures),duplicate_source_urls_skipped:duplicateUrls,source_id_collisions:sourceIdCollisions,canonical_collision_groups:[...canonicals.values()].filter(n=>n>1).length,completeness:{lyrics,release_dates:dates,durations,album_title_links:albumLinks},pass:tracks+failures>=expected&&duplicateUrls===0&&sourceIdCollisions===0};
await fsp.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
