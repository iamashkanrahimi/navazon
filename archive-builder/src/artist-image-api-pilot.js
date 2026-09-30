import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, sleep } from './utils.js';

const INPUT=path.resolve(process.argv[2]||'./runtime/complete/artists/rj-artists.jsonl.gz');
const OUT=path.resolve(process.argv[3]||'./out/image-api-pilot');
await fsp.mkdir(OUT,{recursive:true});

const rows=[];
const rl=readline.createInterface({input:fs.createReadStream(INPUT).pipe(zlib.createGunzip()),crlfDelay:Infinity});
for await(const line of rl){if(!line.trim())continue;const r=JSON.parse(line);if(!r.image_url)rows.push(r);}
rows.sort((a,b)=>(b.track_count||0)-(a.track_count||0)||a.display_name.localeCompare(b.display_name));
const top=rows.slice(0,20);
const mid=rows.slice(Math.floor(rows.length/2),Math.floor(rows.length/2)+5);
const tail=rows.slice(-5);
const selected=[...top,...mid,...tail];

const headers={
  Accept:'application/json, text/plain, */*',
  'Accept-Language':'en-US',
  'x-rj-user-agent':'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};
function imageFields(obj){
  const out={};
  for(const k of ['photo','photo_player','photo_thumb','background']){
    const v=cleanText(obj?.[k]||''); if(v) out[k]=v;
  }
  if(Array.isArray(obj?.photos)) out.photos=obj.photos;
  return out;
}
const results=[];
for(const artist of selected){
  await sleep(1400+Math.floor(Math.random()*200));
  const u=new URL('https://rj-deskcloud.com/api2/artist');
  u.searchParams.set('query',artist.display_name);
  try{
    const res=await fetch(u,{headers,redirect:'follow'});
    const txt=await res.text();
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data=JSON.parse(txt);
    const actual=cleanText(data?.query||data?.name||'');
    const identity_ok=!actual || normalizeText(actual)===normalizeText(artist.display_name);
    const images=imageFields(data);
    const rec={artist:artist.display_name,track_count:artist.track_count||0,canonical_url:artist.canonical_url,status:res.status,identity_ok,actual,images,api_keys:Object.keys(data||{}).sort()};
    results.push(rec);
    console.log(JSON.stringify({artist:rec.artist,track_count:rec.track_count,identity_ok,images}));
  }catch(e){
    results.push({artist:artist.display_name,track_count:artist.track_count||0,canonical_url:artist.canonical_url,error:e.message});
    console.log(JSON.stringify({artist:artist.display_name,error:e.message}));
  }
}
const withPhoto=results.filter(r=>r.identity_ok&&r.images&&Object.keys(r.images).length).length;
const summary={selected:results.length,with_image_fields:withPhoto,without_image_fields:results.filter(r=>!r.error&&(!r.images||!Object.keys(r.images).length)).length,errors:results.filter(r=>r.error).length};
await fsp.writeFile(path.join(OUT,'results.json'),JSON.stringify(results,null,2));
await fsp.writeFile(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2));
console.log('SUMMARY '+JSON.stringify(summary));