import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { RadioJavanClient, isSystemicError } from './rj-client.js';
import { normalizeSongResponse } from './catalog.js';
import { slugFromUrl } from './utils.js';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function line(value) { return `${JSON.stringify(value)}\n`; }

export async function harvestUrls(urls, {
  outDir,
  label = 'batch',
  client = new RadioJavanClient(),
  systemicThreshold = Number(process.env.RJ_SYSTEMIC_FAILURE_THRESHOLD || 5),
  progressEvery = 25,
} = {}) {
  ensureDir(outDir);
  const tracksPath = path.join(outDir, `${label}-tracks.jsonl.gz`);
  const failuresPath = path.join(outDir, `${label}-failures.jsonl.gz`);
  const tracks = zlib.createGzip({ level: 9 });
  const failures = zlib.createGzip({ level: 9 });
  tracks.pipe(fs.createWriteStream(tracksPath));
  failures.pipe(fs.createWriteStream(failuresPath));

  let success = 0;
  let failed = 0;
  let consecutiveSystemic = 0;
  const startedAt = new Date().toISOString();
  let fatal = null;

  for (let index = 0; index < urls.length; index += 1) {
    const sourceUrl = urls[index];
    const sourceSlug = slugFromUrl(sourceUrl);
    try {
      const result = await client.song(sourceSlug);
      const record = normalizeSongResponse(result.json, { sourceUrl, sourceSlug, rawText: result.rawText });
      record.fetch_attempts = result.attempts;
      tracks.write(line(record));
      success += 1;
      consecutiveSystemic = 0;
    } catch (error) {
      failed += 1;
      if (isSystemicError(error)) consecutiveSystemic += 1;
      else consecutiveSystemic = 0;
      failures.write(line({
        source_url: sourceUrl,
        source_slug: sourceSlug,
        category: error?.category || 'unknown',
        status: error?.status || null,
        attempt: error?.attempt || null,
        message: String(error?.message || error).slice(0, 1000),
        at: new Date().toISOString(),
      }));
      if (consecutiveSystemic >= systemicThreshold) {
        fatal = {
          reason: 'systemic_failure_threshold',
          consecutive_systemic: consecutiveSystemic,
          last_category: error?.category || 'unknown',
          last_status: error?.status || null,
          last_message: String(error?.message || error).slice(0, 500),
        };
        break;
      }
    }
    if ((index + 1) % progressEvery === 0 || index + 1 === urls.length) {
      console.log(JSON.stringify({ label, processed: index + 1, total: urls.length, success, failed, consecutiveSystemic }));
    }
  }

  await Promise.all([
    new Promise(resolve => tracks.end(resolve)),
    new Promise(resolve => failures.end(resolve)),
  ]);

  const summary = {
    label,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    selected: urls.length,
    success,
    failed,
    unprocessed: Math.max(0, urls.length - success - failed),
    fatal,
    tracks_file: path.basename(tracksPath),
    failures_file: path.basename(failuresPath),
  };
  fs.writeFileSync(path.join(outDir, `${label}-summary.json`), JSON.stringify(summary, null, 2));
  return summary;
}
