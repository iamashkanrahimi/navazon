import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs, intValue } from './utils.js';
import { PageClient, resolveArtist } from './phase2-pages.js';

const args=parseArgs();const input=path.resolve(args.in||'./runtime/phase2/artist-candidates.jsonl');const outDir=path.resolve(args.out||'./out/phase2-artists');
const shard=intValue(args.shard,0),shards=intValue(args.shards,64);await fsp.mkdir(outDir,{recursive:true});
const rows=(await fsp.readFile(input,'utf8')).split(/\n/).filter(Boolean).map(JSON.parse).filter((_,i)=>i%shards===shard);
const resolved=[],failures=[];const client=new PageClient();
for(const row of rows){try{resolved.push(await resolveArtist(client,row,{deep:false}));}catch(e){failures.push({...row,error:e.message,status:e.status||null});}}
const writeGz=async(file,data)=>new Promise((resolve,reject)=>{const gz=zlib.createGzip({level:9});const out=fs.createWriteStream(file);out.on('finish',resolve);out.on('error',reject);gz.on('error',reject);gz.pipe(out);for(const x of data)gz.write(JSON.stringify(x)+'\n');gz.end();});
await writeGz(path.join(outDir,`artist-${shard}-resolved.jsonl.gz`),resolved);await writeGz(path.join(outDir,`artist-${shard}-failures.jsonl.gz`),failures);
const summary={shard,shards,selected:rows.length,resolved:resolved.length,failed:failures.length,with_image:resolved.filter(x=>x.image_url).length,album_links:resolved.reduce((n,x)=>n+x.album_urls.length,0)};
await fsp.writeFile(path.join(outDir,`artist-${shard}-summary.json`),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));