import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSnapshot, selectPilotUrls } from './snapshot.js';
import { harvestUrls } from './harvest.js';
import { parseArgs, intValue } from './utils.js';

const args = parseArgs();
const limit = intValue(args.limit, 50);
const outDir = path.resolve(args.out || './out/pilot');

let selected;
if (args['urls-file']) {
  const text = await fs.readFile(path.resolve(args['urls-file']), 'utf8');
  selected = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (new Set(selected).size !== selected.length) throw new Error('Pilot URL file contains duplicates');
  selected = selected.slice(0, limit);
} else {
  const { urls } = await loadSnapshot(args.snapshot || process.env.RJ_SNAPSHOT_FILE || './runtime/song-urls.txt.gz');
  selected = selectPilotUrls(urls, limit);
}

if (!selected.length) throw new Error('Pilot URL set is empty');
const summary = await harvestUrls(selected, { outDir, label: 'pilot', systemicThreshold: 3, progressEvery: 10 });
console.log(JSON.stringify(summary, null, 2));
if (summary.fatal || summary.success / Math.max(1, summary.selected) < 0.90) process.exitCode = 2;
