import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, parseArgs, intValue, sleep } from './utils.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/v4/albums/rj-albums.jsonl.gz');
const outDir=path.resolve(args.out||'./out/album-api-repair');
const shard=intValue(args.shard,0),shards=intValue(args.shards,32);
await fsp.mkdir(outDir,{recursive:true});

const all=[];
const rl=readline.createInterface({input:fs.createReadStream(input).pipe(zlib.createGunzip()),crlfDelay:Infinity});
let idx=0;
for await(const line of rl){if(!line.trim())continue;const row=JSON.parse(line);if((idx++%shards)===shard)all.push(row);}

const headers={Accept:'application/json, text/plain, */*','Accept-Language':'en-US','x-rj-user-agent':'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'};
function slugQuery(url){const slug=new URL(url).pathname.replace(/^\/album\//i,'').replace(/\/$/,'');return decodeURIComponent(slug).replace(/-/g,' ');}
function scoreAlbum(item,a,q){
  const title=cleanText(item?.album_album||item?.name||'');
  const artist=cleanText(item?.album_artist||item?.artist||'');
  let s=0;
  if(a.title&&normalizeText(title)===normalizeText(a.title))s+=10;
  if(a.candidate_artist&&normalizeText(artist)===normalizeText(a.candidate_artist))s+=8;
  const nq=normalizeText(q);
  if(title&&nq.includes(normalizeText(title)))s+=3;
  if(artist&&nq.includes(normalizeText(artist)))s+=3;
  return {s,title,artist};
}
async function getJson(endpoint,params){
  const u=new URL('https://rj-deskcloud.com/api2/'+endpoint);
  for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
  let last;
  for(let attempt=1;attempt<=3;attempt++){
    await sleep(1400+Math.floor(Math.random()*250));
    const c=new AbortController();const timer=setTimeout(()=>c.abort(),20000);
    try{
      const res=await fetch(u,{headers,redirect:'follow',signal:c.signal});const txt=await res.text();
      if(!res.ok){const e=new Error(`HTTP ${res.status}`);e.status=res.status;throw e;}
      return {data:JSON.parse(txt),attempts:attempt};
    }catch(e){last=e;if([400,404,410,401,403].includes(Number(e.status||0))||attempt===3)break;await sleep(1000*(2**(attempt-1)));}
    finally{clearTimeout(timer);}
  }
  throw last||new Error('api request failed');
}
function trackRec(t,i){
  return {
    position:i+1,
    source_id:t?.id==null?null:String(t.id),
    permlink:cleanText(t?.permlink||'')||null,
    share_url:cleanText(t?.share_link||'')||null,
    artist:cleanText(t?.artist||'')||null,
    title:cleanText(t?.song||t?.title||'')||null,
    title_farsi:cleanText(t?.song_farsi||'')||null,
    duration_seconds:Number.isFinite(Number(t?.duration))?Number(t.duration):null,
    cover_url:cleanText(t?.photo||'')||null,
    explicit:typeof t?.explicit==='boolean'?t.explicit:null
  };
}
const resolved=[],failures=[];
for(const a of all){
  try{
    const q=slugQuery(a.canonical_url);
    const sr=await getJson('search',{query:q});
    const albums=Array.isArray(sr.data?.albums)?sr.data.albums:[];
    const ranked=albums.map(x=>({...scoreAlbum(x,a,q),item:x})).sort((x,y)=>y.s-x.s);
    const best=ranked[0];
    if(!best||best.s<6)throw new Error('no confident album search match');
    const id=best.item?.id;
    if(id==null)throw new Error('album search result missing id');
    const detail=await getJson('mp3',{id:String(id)});
    const data=detail.data;
    const ts=Array.isArray(data?.album_tracks)?data.album_tracks:[];
    if(!ts.length)throw new Error('album_tracks missing');
    const tracks=ts.map(trackRec);
    const duration=tracks.reduce((n,t)=>n+(t.duration_seconds||0),0);
    resolved.push({
      ...a,
      api_source_id:String(id),
      artist_display:cleanText(data?.album_artist||best.artist||a.candidate_artist||'')||null,
      title:cleanText(data?.album_album||best.title||a.title||'')||a.title||null,
      release_date_raw:cleanText(data?.album_date||data?.date||a.release_date_text||'')||null,
      track_count:tracks.length,
      duration_seconds:duration||null,
      tracks,
      api_match_score:best.s,
      api_match_query:q,
      api_attempts:(sr.attempts||1)+(detail.attempts||1)
    });
  }catch(e){failures.push({canonical_url:a.canonical_url,title:a.title||null,error:e.message,status:e.status||null});}
}
async function gz(file,rows){return new Promise((res,rej)=>{const g=zlib.createGzip({level:9});const o=fs.createWriteStream(file);o.on('finish',res);o.on('error',rej);g.on('error',rej);g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();});}
await gz(path.join(outDir,`album-api-${shard}-resolved.jsonl.gz`),resolved);
await gz(path.join(outDir,`album-api-${shard}-failures.jsonl.gz`),failures);
const summary={shard,selected:all.length,resolved:resolved.length,failed:failures.length,tracks:resolved.reduce((n,a)=>n+a.tracks.length,0),low_score:resolved.filter(a=>a.api_match_score<10).length};
await fsp.writeFile(path.join(outDir,`album-api-${shard}-summary.json`),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));