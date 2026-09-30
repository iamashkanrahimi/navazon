import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { parseArgs } from './utils.js';

const args = parseArgs();
const inputDir = path.resolve(args.input);
const outDir = path.resolve(args.out || './out/archive-v5-profile-taxonomy');
await fsp.mkdir(outDir, { recursive: true });

async function readGz(file) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function writeGz(file, rows) {
  return new Promise((resolve, reject) => {
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
    gzip.pipe(out);
    for (const row of rows) gzip.write(JSON.stringify(row) + '\n');
    gzip.end();
  });
}

function isRadioJavanProfileAsset(url = '') {
  const value = String(url || '');
  return /\/static\/artists\//i.test(value)
    || /\/artist_panel_submissions\//i.test(value);
}

const tracks = await readGz(path.join(inputDir, 'rj-tracks.jsonl.gz'));
const artists = await readGz(path.join(inputDir, 'rj-artists.jsonl.gz'));
const albums = await readGz(path.join(inputDir, 'rj-albums.jsonl.gz'));
const albumTracks = await readGz(path.join(inputDir, 'rj-album-tracks.jsonl.gz'));

let newlyNormalized = 0;
for (const artist of artists) {
  const alreadyProfile = artist.image_kind === 'artist_profile';
  const eligibleRadioJavanProfile =
    artist.image_kind !== 'track_art_fallback'
    && isRadioJavanProfileAsset(artist.image_url);

  if (!alreadyProfile && eligibleRadioJavanProfile) {
    artist.previous_image_kind = artist.image_kind ?? null;
    artist.image_kind = 'artist_profile';
    artist.profile_image_verified = true;
    artist.profile_image_verification = 'radiojavan_artist_asset_path';
    newlyNormalized += 1;
  } else if (alreadyProfile) {
    artist.profile_image_verified = true;
    artist.profile_image_verification ||= String(artist.image_source || '').startsWith('spotify')
      ? 'spotify_direct_track_match'
      : 'existing_artist_profile';
  }
}

const profileArtists = artists.filter(a => a.image_kind === 'artist_profile');
const nonProfileArtists = artists.filter(a => a.image_kind !== 'artist_profile');
if (artists.length !== 9263) throw new Error(`expected 9263 artists, got ${artists.length}`);
if (profileArtists.length !== 1060) throw new Error(`expected 1060 artist profiles, got ${profileArtists.length}`);
if (nonProfileArtists.length !== 8203) throw new Error(`expected 8203 non-profile artists, got ${nonProfileArtists.length}`);
if (newlyNormalized !== 920) throw new Error(`expected 920 newly normalized profiles, got ${newlyNormalized}`);

const media = new Map();
const add = (url, type, ref) => {
  if (!url) return;
  let row = media.get(url);
  if (!row) {
    row = { source_url: url, usage_types: new Set(), refs: [] };
    media.set(url, row);
  }
  row.usage_types.add(type);
  if (row.refs.length < 5) row.refs.push(ref);
};

for (const track of tracks) add(track.cover_url, 'track_cover', track.source_url);
for (const artist of artists) {
  add(
    artist.image_url,
    artist.image_kind === 'artist_profile' ? 'artist_image' : 'artist_artwork',
    artist.canonical_url
  );
}
for (const album of albums) add(album.cover_url, 'album_cover', album.canonical_url);

const mediaRows = [...media.values()]
  .map(row => ({
    source_url: row.source_url,
    usage_types: [...row.usage_types].sort(),
    sample_refs: row.refs,
  }))
  .sort((a, b) => a.source_url.localeCompare(b.source_url));

for (const artist of profileArtists) {
  const mediaRow = media.get(artist.image_url);
  if (!mediaRow?.usage_types?.has('artist_image')) {
    throw new Error('profile artist missing artist_image usage: ' + artist.canonical_url);
  }
}
for (const artist of nonProfileArtists) {
  const mediaRow = media.get(artist.image_url);
  if (!mediaRow?.usage_types?.has('artist_artwork')) {
    throw new Error('non-profile artist missing artist_artwork usage: ' + artist.canonical_url);
  }
}

const passthrough = ['rj-tracks.jsonl.gz', 'rj-albums.jsonl.gz', 'rj-album-tracks.jsonl.gz'];
for (const file of passthrough) {
  await fsp.copyFile(path.join(inputDir, file), path.join(outDir, file));
}
await writeGz(path.join(outDir, 'rj-artists.jsonl.gz'), artists);
await writeGz(path.join(outDir, 'media-images.jsonl.gz'), mediaRows);

const oldManifest = JSON.parse(await fsp.readFile(path.join(inputDir, 'manifest.json'), 'utf8'));
const files = [
  'rj-tracks.jsonl.gz',
  'rj-artists.jsonl.gz',
  'rj-albums.jsonl.gz',
  'rj-album-tracks.jsonl.gz',
  'media-images.jsonl.gz',
];
const hashes = {};
for (const file of files) {
  const buf = await fsp.readFile(path.join(outDir, file));
  hashes[file] = crypto.createHash('sha256').update(buf).digest('hex');
}

const counts = {
  ...(oldManifest.counts || {}),
  tracks: tracks.length,
  artists: artists.length,
  albums: albums.length,
  album_tracks: albumTracks.length,
  media_images: mediaRows.length,
  artist_profiles: profileArtists.length,
  artist_artwork_only: nonProfileArtists.length,
};

const manifest = {
  ...oldManifest,
  created_at: new Date().toISOString(),
  counts,
  hashes,
};
await fsp.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const summary = {
  artists: artists.length,
  artist_profiles: profileArtists.length,
  artist_artwork_only: nonProfileArtists.length,
  newly_normalized_radiojavan_profiles: newlyNormalized,
  media_images: mediaRows.length,
  media_artist_image_rows: mediaRows.filter(r => r.usage_types.includes('artist_image')).length,
  media_artist_artwork_rows: mediaRows.filter(r => r.usage_types.includes('artist_artwork')).length,
  media_artist_artwork_only_rows: mediaRows.filter(r =>
    r.usage_types.includes('artist_artwork')
    && !r.usage_types.some(t => ['artist_image', 'track_cover', 'album_cover'].includes(t))
  ).length,
};
await fsp.writeFile(
  path.join(outDir, 'artist-profile-taxonomy-summary.json'),
  JSON.stringify(summary, null, 2)
);
console.log(JSON.stringify(summary, null, 2));
