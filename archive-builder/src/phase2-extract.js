import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, parseArgs, splitArtistNames } from './utils.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/final/rj-tracks.jsonl.gz');
const outDir=path.resolve(args.out||'./runtime/phase2');
await fsp.mkdir(outDir,{recursive:true});
const artists=new Map();const albums=new Map();let tracks=0;
const stream=fs.createReadStream(input).pipe(zlib.createGunzip());
const rl=readline.createInterface({input:stream,crlfDelay:Infinity});
for await(const line of rl){
  if(!line.trim())continue;const row=JSON.parse(line);tracks++;
  const names=(Array.isArray(row.artist_tags)&&row.artist_tags.length?row.artist_tags:splitArtistNames(row.artist_display||'',[])).map(cleanText).filter(Boolean);
  for(const name of names){
    const key=normalizeText(name);if(!key)continue;
    let a=artists.get(key);if(!a){a={key,candidate_name:name,farsi_names:[],track_count:0,sample_track_urls:[],track_ids:[]};artists.set(key,a);} a.track_count+=1;
    if(a.sample_track_urls.length<3&&row.source_url&&!a.sample_track_urls.includes(row.source_url))a.sample_track_urls.push(row.source_url);
    if(a.track_ids.length<8&&row.source_id&&!a.track_ids.includes(row.source_id))a.track_ids.push(row.source_id); if(names.length===1&&row.artist_farsi&&!a.farsi_names.includes(row.artist_farsi))a.farsi_names.push(row.artist_farsi);
  }
  if(row.album_source_url){
    let a=albums.get(row.album_source_url);
    if(!a){a={source_url:row.album_source_url,title:row.album_title||null,title_farsi:row.album_farsi||null,artist:row.album_artist||row.artist_display||null,track_ids:[],sample_track_urls:[],cover_urls:[],track_refs:Array.isArray(row.album_track_refs)?row.album_track_refs:[]};albums.set(row.album_source_url,a);}
    if(row.source_id&&!a.track_ids.includes(row.source_id))a.track_ids.push(row.source_id);
    if(row.source_url&&a.sample_track_urls.length<3&&!a.sample_track_urls.includes(row.source_url))a.sample_track_urls.push(row.source_url);
    if(row.cover_url&&a.cover_urls.length<3&&!a.cover_urls.includes(row.cover_url))a.cover_urls.push(row.cover_url);
  }
}
const artistRows=[...artists.values()].sort((a,b)=>a.key.localeCompare(b.key));
const albumRows=[...albums.values()].sort((a,b)=>a.source_url.localeCompare(b.source_url));
await fsp.writeFile(path.join(outDir,'artist-candidates.jsonl'),artistRows.map(x=>JSON.stringify(x)).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'album-candidates.jsonl'),albumRows.map(x=>JSON.stringify(x)).join('\n')+'\n');
const summary={tracks,artist_candidates:artistRows.length,album_candidates:albumRows.length};
await fsp.writeFile(path.join(outDir,'extract-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
