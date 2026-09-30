import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, parseArgs, intValue, sleep } from './utils.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/complete/artists/rj-artists.jsonl.gz');
const outDir=path.resolve(args.out||'./out/artist-api-images');
const shard=intValue(args.shard,0),shards=intValue(args.shards,64);
await fsp.mkdir(outDir,{recursive:true});

const missing=[];
const rl=readline.createInterface({input:fs.createReadStream(input).pipe(zlib.createGunzip()),crlfDelay:Infinity});
let missingIndex=0;
for await(const line of rl){
  if(!line.trim()) continue;
  const row=JSON.parse(line);
  if(row.image_url) continue;
  if((missingIndex++ % shards)===shard) missing.push(row);
}

const headers={
  Accept:'application/json, text/plain, */*',
  'Accept-Language':'en-US',
  'x-rj-user-agent':'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};

function classifyImage(url=''){
  let p='';
  try{ p=new URL(url).pathname.toLowerCase(); }catch{}
  if(p.includes('/static/artists/')||p.includes('/static/artist_panel_submissions/')) return 'artist_profile';
  if(p.includes('/static/mp3/')) return 'track_art_fallback';
  return 'artist_api_image';
}
function obviousPlaceholder(url=''){
  return /(?:placeholder|default[-_/]?(?:artist|photo|avatar)|no[-_]?image|unknown[-_]?artist)/i.test(url);
}
async function artistApi(name){
  const u=new URL('https://rj-deskcloud.com/api2/artist');
  u.searchParams.set('query',name);
  let last;
  for(let attempt=1;attempt<=3;attempt++){
    await sleep(1400+Math.floor(Math.random()*250));
    const c=new AbortController();const timer=setTimeout(()=>c.abort(),20000);
    try{
      const res=await fetch(u,{headers,redirect:'follow',signal:c.signal});
      const txt=await res.text();
      if(!res.ok){const e=new Error(`HTTP ${res.status}`);e.status=res.status;throw e;}
      return {data:JSON.parse(txt),attempts:attempt};
    }catch(e){last=e;if([400,404,410,401,403].includes(Number(e.status||0))||attempt===3)break;await sleep(1000*(2**(attempt-1)));}
    finally{clearTimeout(timer);}
  }
  throw last||new Error('artist api failed');
}
const patches=[],unresolved=[],failures=[];
for(const row of missing){
  try{
    const {data,attempts}=await artistApi(row.display_name);
    const actual=cleanText(data?.query||data?.name||'');
    if(actual&&normalizeText(actual)!==normalizeText(row.display_name)) throw new Error(`artist identity mismatch expected=${row.display_name} actual=${actual}`);
    const photo=cleanText(data?.photo||'');
    if(!photo||obviousPlaceholder(photo)){
      unresolved.push({canonical_url:row.canonical_url,display_name:row.display_name,reason:!photo?'api_photo_missing':'placeholder_photo'});
      continue;
    }
    patches.push({
      canonical_url:row.canonical_url,
      display_name:row.display_name,
      image_url:photo,
      image_source:'radiojavan_artist_api',
      image_kind:classifyImage(photo),
      image_api:{
        photo,
        photo_player:cleanText(data?.photo_player||'')||null,
        photo_thumb:cleanText(data?.photo_thumb||'')||null,
        background:cleanText(data?.background||'')||null
      },
      attempts
    });
  }catch(e){
    failures.push({canonical_url:row.canonical_url,display_name:row.display_name,error:e.message,status:e.status||null});
  }
}
async function gz(file,rows){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();});}
await gz(path.join(outDir,`api-image-${shard}-patches.jsonl.gz`),patches);
await gz(path.join(outDir,`api-image-${shard}-unresolved.jsonl.gz`),unresolved);
await gz(path.join(outDir,`api-image-${shard}-failures.jsonl.gz`),failures);
const summary={shard,selected:missing.length,repaired:patches.length,artist_profile:patches.filter(x=>x.image_kind==='artist_profile').length,track_art_fallback:patches.filter(x=>x.image_kind==='track_art_fallback').length,other_image:patches.filter(x=>x.image_kind==='artist_api_image').length,unresolved:unresolved.length,failed:failures.length};
await fsp.writeFile(path.join(outDir,`api-image-${shard}-summary.json`),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));