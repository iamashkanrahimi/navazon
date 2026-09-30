import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs,intValue,normalizeText } from './utils.js';
import { PageClient,imageProxyOriginals } from './phase2-pages.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/image-repair/candidates.jsonl');
const outDir=path.resolve(args.out||'./out/image-repair');
const shard=intValue(args.shard,0),shards=intValue(args.shards,64);
await fsp.mkdir(outDir,{recursive:true});
const rows=(await fsp.readFile(input,'utf8')).split(/\n/).filter(Boolean).map(JSON.parse).filter((_,i)=>i%shards===shard);
const client=new PageClient();
const patches=[],unresolved=[],failures=[];
function h1(html=''){const m=String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);return m?String(m[1]).replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim():null;}
for(const row of rows){
  try{
    const page=await client.fetch(row.canonical_url);
    const title=h1(page.html);
    if(title && row.display_name && normalizeText(title)!==normalizeText(row.display_name)){
      throw new Error(`artist identity mismatch expected=${row.display_name} actual=${title}`);
    }
    const images=imageProxyOriginals(page.html,'artist');
    if(images.length) patches.push({canonical_url:row.canonical_url,image_url:images[0]});
    else unresolved.push({...row,reason:'image_not_found'});
  }catch(e){failures.push({...row,error:e.message,status:e.status||null});}
}
async function gz(file,data){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const x of data)g.write(JSON.stringify(x)+'\n');g.end();});}
await gz(path.join(outDir,`repair-${shard}-patches.jsonl.gz`),patches);
await gz(path.join(outDir,`repair-${shard}-unresolved.jsonl.gz`),unresolved);
await gz(path.join(outDir,`repair-${shard}-failures.jsonl.gz`),failures);
const summary={shard,selected:rows.length,repaired:patches.length,unresolved:unresolved.length,failed:failures.length};
await fsp.writeFile(path.join(outDir,`repair-${shard}-summary.json`),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));