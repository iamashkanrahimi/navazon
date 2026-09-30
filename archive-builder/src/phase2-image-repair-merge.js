import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs } from './utils.js';

const args=parseArgs();
const original=path.resolve(args.original||'./runtime/artists/rj-artists.jsonl.gz');
const repairs=path.resolve(args.repairs||'./artifacts/image-repair');
const outDir=path.resolve(args.out||'./out/complete/artists');
await fsp.mkdir(outDir,{recursive:true});
async function files(d){let o=[];for(const e of await fsp.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);o.push(...(e.isDirectory()?await files(p):[p]));}return o;}
async function readGz(file,fn){const rl=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const l of rl)if(l.trim())fn(JSON.parse(l));}
const all=await files(repairs);
const patches=new Map();const unresolved=[];const failures=[];
for(const f of all.filter(x=>/-patches\.jsonl\.gz$/.test(x)))await readGz(f,r=>patches.set(r.canonical_url,r.image_url));
for(const f of all.filter(x=>/-unresolved\.jsonl\.gz$/.test(x)))await readGz(f,r=>unresolved.push(r));
for(const f of all.filter(x=>/-failures\.jsonl\.gz$/.test(x)))await readGz(f,r=>failures.push(r));
const rows=[];let before=0,applied=0,after=0;
await readGz(original,row=>{
  if(row.image_url)before++;
  if(!row.image_url&&patches.has(row.canonical_url)){row.image_url=patches.get(row.canonical_url);row.image_source='artist_image_repair';applied++;}
  if(row.image_url)after++;
  rows.push(row);
});
rows.sort((a,b)=>a.canonical_url.localeCompare(b.canonical_url));
const g=zlib.createGzip({level:9});const o=fs.createWriteStream(path.join(outDir,'rj-artists.jsonl.gz'));g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');await new Promise((res,rej)=>{o.on('finish',res);o.on('error',rej);g.end();});
await fsp.writeFile(path.join(outDir,'artists-sitemap.txt'),rows.map(x=>x.canonical_url).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'artist-image-urls.txt'),rows.filter(x=>x.image_url).map(x=>x.image_url).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'artist-image-unresolved.jsonl'),unresolved.map(x=>JSON.stringify(x)).join('\n')+(unresolved.length?'\n':''));
await fsp.writeFile(path.join(outDir,'artist-image-failures.jsonl'),failures.map(x=>JSON.stringify(x)).join('\n')+(failures.length?'\n':''));
const summary={artists:rows.length,images_before:before,images_repaired:applied,images_after:after,still_without_image:rows.length-after,request_failures:failures.length};
await fsp.writeFile(path.join(outDir,'artist-image-repair-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));