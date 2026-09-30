import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import zlib from 'node:zlib';import readline from 'node:readline';import { parseArgs } from './utils.js';
const args=parseArgs();const inDir=path.resolve(args.in||'./artifacts/album-api');const outDir=path.resolve(args.out||'./out/albums-repaired');await fsp.mkdir(outDir,{recursive:true});
async function files(d){let o=[];for(const e of await fsp.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);o.push(...(e.isDirectory()?await files(p):[p]));}return o;}
async function readGz(file,fn){const rl=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const l of rl)if(l.trim())fn(JSON.parse(l));}
async function writeGz(file,rows){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();});}
const all=await files(inDir);const map=new Map(),failures=[];
for(const f of all.filter(x=>/-resolved\.jsonl\.gz$/.test(x)))await readGz(f,r=>map.set(r.canonical_url,r));
for(const f of all.filter(x=>/-failures\.jsonl\.gz$/.test(x)))await readGz(f,r=>failures.push(r));
const albums=[...map.values()].sort((a,b)=>a.canonical_url.localeCompare(b.canonical_url));
const trackRows=[];for(const a of albums)for(const t of a.tracks||[])trackRows.push({album_key:a.canonical_url,canonical_url:a.canonical_url,...t});
await writeGz(path.join(outDir,'rj-albums.jsonl.gz'),albums);await writeGz(path.join(outDir,'rj-album-tracks.jsonl.gz'),trackRows);
await fsp.writeFile(path.join(outDir,'albums-sitemap.txt'),albums.map(a=>a.canonical_url).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'album-api-failures.jsonl'),failures.map(x=>JSON.stringify(x)).join('\n')+(failures.length?'\n':''));
const summary={albums:albums.length,failures:failures.length,album_tracks:trackRows.length,with_cover:albums.filter(a=>a.cover_url).length,with_tracks:albums.filter(a=>a.tracks?.length).length,unique_track_source_ids:new Set(trackRows.map(t=>t.source_id).filter(Boolean)).size,low_score:albums.filter(a=>a.api_match_score<10).length};
await fsp.writeFile(path.join(outDir,'album-api-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));