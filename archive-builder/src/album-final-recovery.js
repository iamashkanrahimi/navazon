import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, parseArgs, sleep } from './utils.js';

const args = parseArgs();
const inputFile = path.resolve(args.input || './runtime/input/rj-albums.jsonl.gz');
const repairedDir = path.resolve(args.repaired || './runtime/repaired');
const tracksFile = path.resolve(args.tracks || './runtime/songs/rj-tracks.jsonl.gz');
const outDir = path.resolve(args.out || './out/albums-complete');
const expectedAlbums = Number(args.expected || 1923);
await fsp.mkdir(outDir, { recursive: true });

const headers = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US',
  'x-rj-user-agent': 'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};

async function readGz(file) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function writeGz(file, rows) {
  return new Promise((resolve, reject) => {
    const gz = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    out.on('error', reject);
    gz.on('error', reject);
    gz.pipe(out);
    for (const row of rows) gz.write(JSON.stringify(row) + '\n');
    gz.end();
  });
}

function albumArtist(a) {
  if (cleanText(a.candidate_artist || '')) return cleanText(a.candidate_artist);
  for (const raw of a.artist_urls || []) {
    try {
      const slug = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).at(-1) || '').replace(/\+/g, ' ');
      if (slug && normalizeText(slug) !== 'radio javan') return cleanText(slug);
    } catch {}
  }
  return null;
}

function sourceUrlFromPermlink(permlink) {
  return permlink ? 'https://www.radiojavan.com/mp3s/mp3/' + permlink : null;
}

function toTrack(ref, trackById) {
  const full = ref && ref.source_id != null ? trackById.get(String(ref.source_id)) : null;
  const permlink = cleanText((ref && ref.permlink) || (full && full.source_permalink) || '') || null;
  const seconds = Number(ref && ref.duration_seconds);
  const fullSeconds = Number(full && full.duration_seconds);
  return {
    position: Number(ref && ref.position) || null,
    source_id: ref && ref.source_id != null ? String(ref.source_id) : (full && full.source_id != null ? String(full.source_id) : null),
    permlink,
    share_url: cleanText((ref && ref.share_url) || (full && full.source_share_url) || '') || null,
    artist: cleanText((ref && ref.artist) || (full && full.artist_display) || '') || null,
    title: cleanText((ref && ref.title) || (full && full.title) || '') || null,
    title_farsi: cleanText((ref && ref.title_farsi) || (full && full.title_farsi) || '') || null,
    duration_seconds: Number.isFinite(seconds) ? seconds : (Number.isFinite(fullSeconds) ? fullSeconds : null),
    cover_url: cleanText((ref && ref.cover_url) || (full && full.cover_url) || '') || null,
    explicit: typeof (ref && ref.explicit) === 'boolean' ? ref.explicit : (typeof (full && full.explicit) === 'boolean' ? full.explicit : null),
    source_url: (full && full.source_url) || sourceUrlFromPermlink(permlink),
  };
}

function completeRefs(refs, expected) {
  if (!Array.isArray(refs) || refs.length !== expected || expected < 1) return false;
  const positions = refs.map((r, i) => Number(r.position) || i + 1).sort((a, b) => a - b);
  return positions.every((p, i) => p === i + 1) && refs.every(r => r.source_id || r.permlink || r.title);
}

function buildAlbum(a, refs, trackById, kind, extra = {}) {
  const tracks = refs.map((r, i) => toTrack({ ...r, position: Number(r.position) || i + 1 }, trackById));
  const duration = tracks.reduce((n, t) => n + (Number(t.duration_seconds) || 0), 0) || (Number(a.total_minutes) ? Number(a.total_minutes) * 60 : null);
  return {
    ...a,
    api_source_id: extra.api_source_id != null ? String(extra.api_source_id) : null,
    artist_display: cleanText(extra.artist_display || albumArtist(a) || a.artist_display || '') || null,
    title: cleanText(extra.title || a.title || '') || null,
    release_date_raw: cleanText(extra.release_date_raw || a.release_date_text || a.release_date_raw || '') || null,
    track_count: tracks.length,
    duration_seconds: duration,
    tracks,
    api_match_score: extra.api_match_score == null ? null : extra.api_match_score,
    api_match_query: extra.api_match_query || null,
    api_attempts: extra.api_attempts || 0,
    recovery_kind: kind,
  };
}

function titleScore(value, expected) {
  const a = normalizeText(value || '');
  const b = normalizeText(expected || '');
  if (!a || !b) return 0;
  if (a === b) return 12;
  if (a.includes(b) || b.includes(a)) return 7;
  return 0;
}

function artistScore(value, expected) {
  const a = normalizeText(value || '');
  const b = normalizeText(expected || '');
  if (!a || !b) return 0;
  if (a === b) return 9;
  if (a.includes(b) || b.includes(a)) return 5;
  return 0;
}

function slugWords(url, kind) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const i = parts.findIndex(x => x.toLowerCase() === kind);
    const slug = decodeURIComponent((i >= 0 ? parts[i + 1] : parts.at(-1)) || '');
    return cleanText(slug.replace(/[-_]+/g, ' '));
  } catch {
    return '';
  }
}

function permlinkKey(value) {
  return normalizeText(cleanText(value || '').replace(/[-_]+/g, ' '));
}

async function getJson(endpoint, params) {
  const u = new URL('https://rj-deskcloud.com/api2/' + endpoint);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(1400 + Math.floor(Math.random() * 250));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(u, { headers, redirect: 'follow', signal: controller.signal });
      const txt = await res.text();
      if (!res.ok) {
        const e = new Error('HTTP ' + res.status);
        e.status = res.status;
        throw e;
      }
      return { data: JSON.parse(txt), attempts: attempt };
    } catch (e) {
      last = e;
      if ([400, 404, 410, 401, 403].includes(Number(e.status || 0)) || attempt === 3) break;
      await sleep(1000 * (2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error('api request failed');
}

function apiTrackRec(t, i) {
  return {
    position: i + 1,
    source_id: t && t.id != null ? String(t.id) : null,
    permlink: cleanText((t && t.permlink) || '') || null,
    share_url: cleanText((t && t.share_link) || '') || null,
    artist: cleanText((t && t.artist) || '') || null,
    title: cleanText((t && (t.song || t.title)) || '') || null,
    title_farsi: cleanText((t && t.song_farsi) || '') || null,
    duration_seconds: Number.isFinite(Number(t && t.duration)) ? Number(t.duration) : null,
    cover_url: cleanText((t && t.photo) || '') || null,
    explicit: typeof (t && t.explicit) === 'boolean' ? t.explicit : null,
    source_url: t && t.permlink ? sourceUrlFromPermlink(t.permlink) : null,
  };
}

function verifyDetail(a, data, inferredArtist) {
  const ts = Array.isArray(data && data.album_tracks) ? data.album_tracks : [];
  if (!ts.length) return { ok: false };
  const countMatch = Number(a.track_count) > 0 && ts.length === Number(a.track_count);
  const albumTitle = cleanText((data && (data.album_album || data.album || data.album_name)) || '');
  const albumArtistName = cleanText((data && (data.album_artist || data.artist)) || '');
  const tScore = titleScore(albumTitle, a.title);
  const aScore = artistScore(albumArtistName, inferredArtist);
  const wanted = new Set((a.song_urls || []).map(u => permlinkKey(slugWords(u, 'song'))).filter(Boolean));
  let overlap = 0;
  for (const t of ts) if (wanted.has(permlinkKey(t && t.permlink))) overlap++;
  const ok = (countMatch && tScore >= 7) || (countMatch && aScore >= 5 && overlap >= 1) || (tScore >= 12 && overlap >= 1) || overlap >= 2;
  return { ok, albumTitle, albumArtistName, trackCount: ts.length, overlap, tScore, aScore };
}

async function recoverViaApi(a, trackById) {
  const inferredArtist = albumArtist(a);
  const tried = new Set();
  let attempts = 0;

  async function inspect(id, query, score) {
    if (id == null || tried.has(String(id))) return null;
    tried.add(String(id));
    const detail = await getJson('mp3', { id: String(id) });
    attempts += detail.attempts || 1;
    const check = verifyDetail(a, detail.data, inferredArtist);
    if (!check.ok) return null;
    return buildAlbum(a, detail.data.album_tracks.map(apiTrackRec), trackById, 'targeted_api_recovery', {
      api_source_id: String(id),
      artist_display: check.albumArtistName || inferredArtist,
      title: check.albumTitle || a.title,
      release_date_raw: cleanText((detail.data && (detail.data.album_date || detail.data.date)) || a.release_date_text || '') || null,
      api_match_score: score,
      api_match_query: query,
      api_attempts: attempts,
    });
  }

  const queries = [];
  function addQuery(q) {
    q = cleanText(q);
    if (q && !queries.includes(q)) queries.push(q);
  }
  addQuery((inferredArtist || '') + ' ' + (a.title || ''));
  addQuery(a.title || '');
  addQuery(slugWords(a.canonical_url, 'album'));

  for (const query of queries) {
    const sr = await getJson('search', { query });
    attempts += sr.attempts || 1;
    const albums = Array.isArray(sr.data && sr.data.albums) ? sr.data.albums : [];
    const ranked = albums.map(item => {
      const title = cleanText((item && (item.album_album || item.name || item.album)) || '');
      const artist = cleanText((item && (item.album_artist || item.artist)) || '');
      return { item, score: titleScore(title, a.title) + artistScore(artist, inferredArtist) };
    }).sort((x, y) => y.score - x.score);
    for (const c of ranked.slice(0, 4)) {
      if (c.score < 7) continue;
      const hit = await inspect(c.item && c.item.id, query, c.score);
      if (hit) return hit;
    }
  }

  const songUrls = [...new Set((a.song_urls || []).map(u => String(u).replace(/\/$/, '')))];
  for (const songUrl of songUrls) {
    const query = slugWords(songUrl, 'song');
    if (!query) continue;
    const sr = await getJson('search', { query });
    attempts += sr.attempts || 1;
    const mp3s = Array.isArray(sr.data && sr.data.mp3s) ? sr.data.mp3s : [];
    const nq = normalizeText(query);
    const ranked = mp3s.map(item => {
      const title = cleanText((item && (item.song || item.title)) || '');
      const artist = cleanText((item && item.artist) || '');
      const nt = normalizeText(title);
      const score = (nt && nq.includes(nt) ? 10 : 0) + artistScore(artist, inferredArtist);
      return { item, score };
    }).sort((x, y) => y.score - x.score);
    for (const c of ranked.slice(0, 4)) {
      if (c.score < 7) continue;
      const hit = await inspect(c.item && c.item.id, query, c.score);
      if (hit) return hit;
    }
  }
  throw new Error('targeted API recovery exhausted for ' + (inferredArtist || 'unknown') + ' - ' + (a.title || 'unknown'));
}

const [inputAlbums, repairedAlbums, frozenTracks] = await Promise.all([
  readGz(inputFile),
  readGz(path.join(repairedDir, 'rj-albums.jsonl.gz')),
  readGz(tracksFile),
]);

const repairedMap = new Map(repairedAlbums.map(a => [a.canonical_url, a]));
const trackById = new Map(frozenTracks.filter(t => t.source_id != null).map(t => [String(t.source_id), t]));
const missing = inputAlbums.filter(a => !repairedMap.has(a.canonical_url));
const unresolved = [];
let phase2 = 0;
let archive = 0;
let api = 0;

for (const a of missing) {
  const expected = Number(a.track_count) || 0;
  if (completeRefs(a.track_refs, expected)) {
    repairedMap.set(a.canonical_url, buildAlbum(a, a.track_refs, trackById, 'phase2_track_refs_recovery'));
    phase2++;
    continue;
  }

  const inferredArtist = albumArtist(a);
  const candidates = frozenTracks.filter(t => {
    if (!completeRefs(t.album_track_refs, expected)) return false;
    if (titleScore(t.album_title, a.title) < 7) return false;
    return !inferredArtist || artistScore(t.album_artist || t.artist_display, inferredArtist) >= 5;
  }).sort((x, y) => artistScore(y.album_artist || y.artist_display, inferredArtist) - artistScore(x.album_artist || x.artist_display, inferredArtist));

  if (candidates.length) {
    repairedMap.set(a.canonical_url, buildAlbum(a, candidates[0].album_track_refs, trackById, 'song_archive_album_refs_recovery', {
      artist_display: candidates[0].album_artist || candidates[0].artist_display || inferredArtist,
      api_source_id: candidates[0].album_source_id || null,
    }));
    archive++;
    continue;
  }

  try {
    repairedMap.set(a.canonical_url, await recoverViaApi(a, trackById));
    api++;
  } catch (e) {
    unresolved.push({ canonical_url: a.canonical_url, title: a.title || null, artist: inferredArtist, error: e.message });
  }
}

const albums = [...repairedMap.values()].sort((a, b) => a.canonical_url.localeCompare(b.canonical_url));
const albumTracks = [];
const issues = [];
for (const a of albums) {
  const ts = a.tracks || [];
  if (!ts.length) issues.push({ canonical_url: a.canonical_url, issue: 'no_tracks' });
  if (Number(a.track_count) !== ts.length) issues.push({ canonical_url: a.canonical_url, issue: 'track_count_mismatch', track_count: a.track_count, rows: ts.length });
  const pos = ts.map((t, i) => Number(t.position) || i + 1).sort((x, y) => x - y);
  if (!pos.every((p, i) => p === i + 1)) issues.push({ canonical_url: a.canonical_url, issue: 'non_contiguous_positions' });
  for (const [i, t] of ts.entries()) albumTracks.push({ album_key: a.canonical_url, canonical_url: a.canonical_url, ...t, position: Number(t.position) || i + 1 });
}

await writeGz(path.join(outDir, 'rj-albums.jsonl.gz'), albums);
await writeGz(path.join(outDir, 'rj-album-tracks.jsonl.gz'), albumTracks);
await fsp.writeFile(path.join(outDir, 'albums-sitemap.txt'), albums.map(a => a.canonical_url).join('\n') + '\n');
await fsp.writeFile(path.join(outDir, 'album-final-recovery-unresolved.json'), JSON.stringify(unresolved, null, 2));
await fsp.writeFile(path.join(outDir, 'album-final-recovery-issues.json'), JSON.stringify(issues, null, 2));

const summary = {
  input_albums: inputAlbums.length,
  initially_repaired: repairedAlbums.length,
  initially_missing: missing.length,
  recovered_phase2_track_refs: phase2,
  recovered_song_archive_refs: archive,
  recovered_targeted_api: api,
  unresolved: unresolved.length,
  final_albums: albums.length,
  final_album_tracks: albumTracks.length,
  album_qa_issues: issues.length,
  expected_albums: expectedAlbums,
};
await fsp.writeFile(path.join(outDir, 'album-final-recovery-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (unresolved.length || issues.length || albums.length !== expectedAlbums) {
  console.error(JSON.stringify({ unresolved, issues: issues.slice(0, 25) }, null, 2));
  process.exitCode = 2;
}
