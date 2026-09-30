import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, sleep } from './utils.js';

const INPUT=path.resolve(process.argv[2]||'./runtime/v3/artists/rj-artists.jsonl.gz');
const OUT=path.resolve(process.argv[3]||'./out/fallback-pilot');
await fsp.mkdir(OUT,{recursive:true});
const isDefault=u=>/\/static\/artists\/600\/default-450e2007\.jpg(?:$|\?)/i.test(String(u||''));
const targets=[];
const rl=readline.createInterface({input:fs.createReadStream(INPUT).pipe(zlib.createGunzip()),crlfDelay:Infinity});
for await(const line of rl){
  if(!line.trim())continue;
  const r=JSON.parse(line);
  if(!r.image_url||isDefault(r.image_url))targets.push(r);
}
targets.sort((a,b)=>(b.track_count||0)-(a.track_count||0));
const selected=[...targets.slice(0,15),...targets.slice(-15)];
const headers={Accept:'application/json, text/plain, */*','Accept-Language':'en-US','x-rj-user-agent':'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'};

function candidatePhotos(data){
  const out=[]; const seen=new Set();
  const add=(url,source)=>{
    url=cleanText(url||''); if(!url||isDefault(url)||seen.has(url))return;
    if(/placeholder|no[-_]?image|unknown[-_]?artist/i.test(url))return;
    seen.add(url); out.push({url,source});
  };
  add(data?.latest?.photo,'latest.photo');
  add(data?.latest?.photo_player,'latest.photo_player');
  add(data?.latest?.thumbnail,'latest.thumbnail');
  for(const x of Array.isArray(data?.mp3s)?data.mp3s:[]){
    add(x?.photo,'mp3s.photo'); add(x?.photo_player,'mp3s.photo_player'); add(x?.thumbnail,'mp3s.thumbnail');
    if(out.length>=5) break;
  }
  for(const x of Array.isArray(data?.albums)?data.albums:[]){
    add(x?.photo,'albums.photo'); add(x?.photo_player,'albums.photo_player');
    if(out.length>=6) break;
  }
  return out;
}
const results=[];
for(const row of selected){
  await sleep(1400+Math.floor(Math.random()*200));
  const u=new URL('https://rj-deskcloud.com/api2/artist');u.searchParams.set('query',row.display_name);
  try{
    const res=await fetch(u,{headers,redirect:'follow'});const txt=await res.text();
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const data=JSON.parse(txt);const actual=cleanText(data?.query||data?.name||'');
    const identity_ok=!actual||normalizeText(actual)===normalizeText(row.display_name);
    const candidates=candidatePhotos(data);
    results.push({artist:row.display_name,identity_ok,candidates,latest_keys:data?.latest?Object.keys(data.latest):[],mp3_count:Array.isArray(data?.mp3s)?data.mp3s.length:0});
    console.log(JSON.stringify({artist:row.display_name,identity_ok,candidates:candidates.slice(0,2),mp3_count:Array.isArray(data?.mp3s)?data.mp3s.length:0}));
  }catch(e){results.push({artist:row.display_name,error:e.message});console.log(JSON.stringify({artist:row.display_name,error:e.message}));}
}
const summary={selected:results.length,with_fallback:results.filter(r=>r.identity_ok&&r.candidates?.length).length,no_fallback:results.filter(r=>!r.error&&(!r.candidates||!r.candidates.length)).length,errors:results.filter(r=>r.error).length};
await fsp.writeFile(path.join(OUT,'results.json'),JSON.stringify(results,null,2));
await fsp.writeFile(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2));
console.log('SUMMARY '+JSON.stringify(summary));