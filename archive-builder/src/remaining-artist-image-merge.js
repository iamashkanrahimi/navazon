import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs } from './utils.js';

const args=parseArgs();
const original=path.resolve(args.original||'./runtime/v3/artists/rj-artists.jsonl.gz');
const repairs=path.resolve(args.repairs||'./artifacts/final-fallback');
const outDir=path.resolve(args.out||'./out/v4/artists');
await fsp.mkdir(outDir,{recursive:true});

const isDefault=u=>/\/static\/artists\/600\/default-450e2007\.jpg(?:$|\?)/i.test(String(u||''));
async function files(d){let o=[];for(const e of await fsp.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);o.push(...(e.isDirectory()?await files(p):[p]));}return o;}
async function readGz(file,fn){const rl=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const l of rl)if(l.trim())fn(JSON.parse(l));}

const all=await files(repairs),patches=new Map(),unresolved=[],failures=[];
for(const f of all.filter(x=>/-patches\.jsonl\.gz$/.test(x)))await readGz(f,r=>patches.set(r.canonical_url,r));
for(const f of all.filter(x=>/-unresolved\.jsonl\.gz$/.test(x)))await readGz(f,r=>unresolved.push(r));
for(const f of all.filter(x=>/-failures\.jsonl\.gz$/.test(x)))await readGz(f,r=>failures.push(r));

const rows=[];let targetsBefore=0,applied=0,meaningful=0,defaultAfter=0,missingAfter=0;
const freq=new Map();
await readGz(original,row=>{
  if(!row.image_url||isDefault(row.image_url))targetsBefore++;
  if((!row.image_url||isDefault(row.image_url))&&patches.has(row.canonical_url)){
    const p=patches.get(row.canonical_url);
    row.image_url=p.image_url;
    row.image_source=p.image_source;
    row.image_kind=p.image_kind;
    row.fallback_source=p.fallback_source;
    applied++;
  }
  if(!row.image_url)missingAfter++;
  else if(isDefault(row.image_url))defaultAfter++;
  else{meaningful++;freq.set(row.image_url,(freq.get(row.image_url)||0)+1);}
  rows.push(row);
});
rows.sort((a,b)=>a.canonical_url.localeCompare(b.canonical_url));
const g=zlib.createGzip({level:9});const o=fs.createWriteStream(path.join(outDir,'rj-artists.jsonl.gz'));g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');await new Promise((res,rej)=>{o.on('finish',res);o.on('error',rej);g.end();});
await fsp.writeFile(path.join(outDir,'artists-sitemap.txt'),rows.map(x=>x.canonical_url).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'artist-image-urls.txt'),rows.filter(x=>x.image_url&&!isDefault(x.image_url)).map(x=>x.image_url).join('\n')+'\n');
await fsp.writeFile(path.join(outDir,'artist-image-final-unresolved.jsonl'),unresolved.map(x=>JSON.stringify(x)).join('\n')+(unresolved.length?'\n':''));
await fsp.writeFile(path.join(outDir,'artist-image-final-failures.jsonl'),failures.map(x=>JSON.stringify(x)).join('\n')+(failures.length?'\n':''));
const repeated=[...freq.entries()].filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]).slice(0,100).map(([image_url,count])=>({image_url,count}));
await fsp.writeFile(path.join(outDir,'repeated-image-urls.json'),JSON.stringify(repeated,null,2));
const summary={artists:rows.length,targets_before:targetsBefore,repaired:applied,meaningful_images_after:meaningful,default_after:defaultAfter,missing_after:missingAfter,request_failures:failures.length,unresolved:unresolved.length,repeated_image_urls:[...freq.values()].filter(n=>n>1).length,max_image_reuse:freq.size?Math.max(...freq.values()):0};
await fsp.writeFile(path.join(outDir,'artist-image-v4-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));