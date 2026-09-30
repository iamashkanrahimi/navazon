import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, parseArgs, intValue, sleep } from './utils.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/v3/artists/rj-artists.jsonl.gz');
const outDir=path.resolve(args.out||'./out/final-fallback');
const shard=intValue(args.shard,0),shards=intValue(args.shards,32);
await fsp.mkdir(outDir,{recursive:true});

const isDefault=u=>/\/static\/artists\/600\/default-450e2007\.jpg(?:$|\?)/i.test(String(u||''));
const targets=[];let idx=0;
const rl=readline.createInterface({input:fs.createReadStream(input).pipe(zlib.createGunzip()),crlfDelay:Infinity});
for await(const line of rl){
  if(!line.trim())continue;
  const r=JSON.parse(line);
  if(!r.image_url||isDefault(r.image_url)){
    if((idx++%shards)===shard)targets.push(r);
  }
}

const headers={
  Accept:'application/json, text/plain, */*',
  'Accept-Language':'en-US',
  'x-rj-user-agent':'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};

function bad(url=''){
  return !url||isDefault(url)||/placeholder|no[-_]?image|unknown[-_]?artist/i.test(url);
}
function candidates(data){
  const out=[];const seen=new Set();
  const add=(url,source)=>{
    url=cleanText(url||'');if(bad(url)||seen.has(url))return;
    seen.add(url);out.push({url,source});
  };
  add(data?.latest?.photo,'latest.photo');
  add(data?.latest?.photo_player,'latest.photo_player');
  add(data?.latest?.thumbnail,'latest.thumbnail');
  for(const x of Array.isArray(data?.mp3s)?data.mp3s:[]){
    add(x?.photo,'mp3s.photo');
    add(x?.photo_player,'mp3s.photo_player');
    add(x?.thumbnail,'mp3s.thumbnail');
    if(out.length>=8)break;
  }
  for(const x of Array.isArray(data?.albums)?data.albums:[]){
    add(x?.photo,'albums.photo');
    add(x?.photo_player,'albums.photo_player');
    if(out.length>=10)break;
  }
  return out;
}
async function fetchArtist(name){
  const u=new URL('https://rj-deskcloud.com/api2/artist');u.searchParams.set('query',name);
  let last;
  for(let attempt=1;attempt<=3;attempt++){
    await sleep(1400+Math.floor(Math.random()*250));
    const c=new AbortController();const timer=setTimeout(()=>c.abort(),20000);
    try{
      const res=await fetch(u,{headers,redirect:'follow',signal:c.signal});
      const txt=await res.text();
      if(!res.ok){const e=new Error(`HTTP ${res.status}`);e.status=res.status;throw e;}
      return {data:JSON.parse(txt),attempts:attempt};
    }catch(e){
      last=e;
      if([400,404,410,401,403].includes(Number(e.status||0))||attempt===3)break;
      await sleep(1000*(2**(attempt-1)));
    }finally{clearTimeout(timer);}
  }
  throw last||new Error('artist api failed');
}

const patches=[],unresolved=[],failures=[];
for(const row of targets){
  try{
    const {data,attempts}=await fetchArtist(row.display_name);
    const actual=cleanText(data?.query||data?.name||'');
    if(actual&&normalizeText(actual)!==normalizeText(row.display_name))throw new Error(`artist identity mismatch expected=${row.display_name} actual=${actual}`);
    const cs=candidates(data);
    if(!cs.length){
      unresolved.push({canonical_url:row.canonical_url,display_name:row.display_name,reason:'no_nondefault_related_artwork'});
      continue;
    }
    const chosen=cs[0];
    patches.push({
      canonical_url:row.canonical_url,
      display_name:row.display_name,
      image_url:chosen.url,
      image_source:'radiojavan_artist_api_related_artwork',
      image_kind:'track_art_fallback',
      fallback_source:chosen.source,
      attempts
    });
  }catch(e){
    failures.push({canonical_url:row.canonical_url,display_name:row.display_name,error:e.message,status:e.status||null});
  }
}

async function gz(file,rows){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();});}
await gz(path.join(outDir,`fallback-${shard}-patches.jsonl.gz`),patches);
await gz(path.join(outDir,`fallback-${shard}-unresolved.jsonl.gz`),unresolved);
await gz(path.join(outDir,`fallback-${shard}-failures.jsonl.gz`),failures);
const summary={shard,selected:targets.length,repaired:patches.length,unresolved:unresolved.length,failed:failures.length,latest_photo:patches.filter(x=>x.fallback_source==='latest.photo').length,other_source:patches.filter(x=>x.fallback_source!=='latest.photo').length};
await fsp.writeFile(path.join(outDir,`fallback-${shard}-summary.json`),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));