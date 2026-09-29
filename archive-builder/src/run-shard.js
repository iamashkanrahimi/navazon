import path from 'node:path';
import { loadSnapshot, shardUrls } from './snapshot.js';
import { harvestUrls } from './harvest.js';
import { parseArgs, intValue } from './utils.js';

const args = parseArgs();
const shardIndex = intValue(args['shard-index'], -1);
const shardCount = intValue(args['shard-count'], 128);
if (shardIndex < 0 || shardIndex >= shardCount) throw new Error('Pass a valid --shard-index');
const outDir = path.resolve(args.out || `./out/shard-${String(shardIndex).padStart(3, '0')}`);
const { urls } = await loadSnapshot(args.snapshot || process.env.RJ_SNAPSHOT_FILE || './runtime/song-urls.txt.gz');
const selected = shardUrls(urls, shardIndex, shardCount);
const label = `shard-${String(shardIndex).padStart(3, '0')}`;
const summary = await harvestUrls(selected, { outDir, label });
console.log(JSON.stringify(summary, null, 2));
if (summary.fatal) process.exitCode = 2;
