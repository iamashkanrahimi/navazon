import path from 'node:path';
import { loadSnapshot, selectPilotUrls } from './snapshot.js';
import { harvestUrls } from './harvest.js';
import { parseArgs, intValue } from './utils.js';

const args = parseArgs();
const limit = intValue(args.limit, 50);
const outDir = path.resolve(args.out || './out/pilot');
const { urls } = await loadSnapshot(args.snapshot || process.env.RJ_SNAPSHOT_FILE || './runtime/song-urls.txt.gz');
const selected = selectPilotUrls(urls, limit);
const summary = await harvestUrls(selected, { outDir, label: 'pilot', systemicThreshold: 3, progressEvery: 10 });
console.log(JSON.stringify(summary, null, 2));
if (summary.fatal || summary.success / Math.max(1, summary.selected) < 0.90) process.exitCode = 2;
