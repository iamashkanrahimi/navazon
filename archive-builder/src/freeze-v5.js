import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import zlib from 'node:zlib';import readline from 'node:readline';import crypto from 'node:crypto';import { parseArgs, normalizeText } from './utils.js';
const args=parseArgs();const tracksFile=path.resolve(args.tracks);const artistsFile=path.resolve(args.artists);const albumsDir=path.resolve(args.albums);const outDir=path.resolve(args.out||'./out/archive-v5');await fsp.mkdir(outDir,{recursive:true});
async function readGz(file){const rows=[];const rl=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const l of rl)if(l.trim())rows.push(JSON.parse(l));return rows;}
async function writeGz(file,rows){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();});}
const tracks=await readGz(tracksFile),artists=await readGz(artistsFile),albums=await readGz(path.join(albumsDir,'rj-albums.jsonl.gz')),albumTracks=await readGz(path.join(albumsDir,'rj-album-tracks.jsonl.gz'));
const tmap=new Map(tracks.map(t=>[t.source_url,t]));const defaultRe=/\/static\/artists\/600\/default-450e2007\.jpg(?:$|\?)/i;let artistFallbacks=0;
for(const a of artists){
  const bad=!a.image_url||defaultRe.test(a.image_url);
  if(bad){
    const u=(a.sample_track_urls||[]).find(x=>tmap.get(x)?.cover_url);
    if(u){a.image_url=tmap.get(u).cover_url;a.image_source='song_archive_track_cover_final_fallback';a.image_kind='track_art_fallback';a.fallback_track_url=u;artistFallbacks++;}
  }
  const flags=[];
  if(normalizeText(a.display_name||'')==='unknown artist')flags.push('generic_unknown_artist');
  if(/^produced:.*photo:.*cover art:/i.test(a.display_name||''))flags.push('suspected_credit_string_not_artist');
  if((a.canonical_url||'').includes('/artist/%2B98')&&a.display_name==='98')flags.push('display_name_lost_plus_prefix');
  if(flags.length)a.quality_flags=[...new Set([...(a.quality_flags||[]),...flags])];
}
artistFallbacks=artists.filter(a=>a.image_source==='song_archive_track_cover_final_fallback').length;
const media=new Map();const add=(url,type,ref)=>{if(!url)return;let m=media.get(url);if(!m){m={source_url:url,usage_types:new Set(),refs:[]};media.set(url,m);}m.usage_types.add(type);if(m.refs.length<5)m.refs.push(ref);};
for(const t of tracks)add(t.cover_url,'track_cover',t.source_url);
for(const a of artists)add(a.image_url,'artist_image',a.canonical_url);
for(const a of albums)add(a.cover_url,'album_cover',a.canonical_url);
const mediaRows=[...media.values()].map(m=>({source_url:m.source_url,usage_types:[...m.usage_types].sort(),sample_refs:m.refs})).sort((a,b)=>a.source_url.localeCompare(b.source_url));
const suspicious=artists.filter(a=>a.quality_flags?.length).map(a=>({canonical_url:a.canonical_url,display_name:a.display_name,quality_flags:a.quality_flags}));
await writeGz(path.join(outDir,'rj-tracks.jsonl.gz'),tracks);await writeGz(path.join(outDir,'rj-artists.jsonl.gz'),artists);await writeGz(path.join(outDir,'rj-albums.jsonl.gz'),albums);await writeGz(path.join(outDir,'rj-album-tracks.jsonl.gz'),albumTracks);await writeGz(path.join(outDir,'media-images.jsonl.gz'),mediaRows);
await fsp.writeFile(path.join(outDir,'artist-quality-flags.json'),JSON.stringify(suspicious,null,2));
const files=['rj-tracks.jsonl.gz','rj-artists.jsonl.gz','rj-albums.jsonl.gz','rj-album-tracks.jsonl.gz','media-images.jsonl.gz'];
const hashes={};for(const f of files){const b=await fsp.readFile(path.join(outDir,f));hashes[f]=crypto.createHash('sha256').update(b).digest('hex');}
const manifest={schema_version:5,created_at:new Date().toISOString(),source_song_run:36646058761,source_artist_run:36752120633,counts:{tracks:tracks.length,artists:artists.length,albums:albums.length,album_tracks:albumTracks.length,media_images:mediaRows.length,artist_final_fallbacks:artistFallbacks,suspicious_artists:suspicious.length,tracks_with_cover:tracks.filter(t=>t.cover_url).length,artists_with_image:artists.filter(a=>a.image_url&&!defaultRe.test(a.image_url)).length,albums_with_cover:albums.filter(a=>a.cover_url).length,tracks_with_lyrics:tracks.filter(t=>t.lyrics_text).length},hashes};
await fsp.writeFile(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));