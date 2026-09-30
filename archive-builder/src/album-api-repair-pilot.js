import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, sleep } from './utils.js';

const INPUT=path.resolve(process.argv[2]||'./runtime/v4/albums/rj-albums.jsonl.gz');
const OUT=path.resolve(process.argv[3]||'./out/album-api-pilot');
await fsp.mkdir(OUT,{recursive:true});
const rows=[];
const rl=readline.createInterface({input:fs.createReadStream(INPUT).pipe(zlib.createGunzip()),crlfDelay:Infinity});
for await(const line of rl)if(line.trim())rows.push(JSON.parse(line));

const pickIdx=[0,1,2,50,100,200,300,500,700,900,1100,1300,1500,1700,1900,rows.length-1].filter(i=>i>=0&&i<rows.length);
const selected=[...new Map(pickIdx.map(i=>[rows[i].canonical_url,rows[i]])).values()];
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
  const res=await fetch(u,{headers,redirect:'follow'});const txt=await res.text();
  if(!res.ok)throw new Error(`HTTP ${res.status}`);
  return JSON.parse(txt);
}
const results=[];
for(const a of selected){
  await sleep(1400);
  try{
    const q=slugQuery(a.canonical_url);
    const search=await getJson('search',{query:q});
    const albums=Array.isArray(search?.albums)?search.albums:[];
    const ranked=albums.map(x=>({...scoreAlbum(x,a,q),item:x})).sort((x,y)=>y.s-x.s);
    const best=ranked[0];
    if(!best||best.s<3)throw new Error('no confident album search match');
    const id=best.item?.id;
    if(id==null)throw new Error('album search result missing id');
    await sleep(1400);
    const data=await getJson('mp3',{id:String(id)});
    const tracks=Array.isArray(data?.album_tracks)?data.album_tracks:[];
    const rec={canonical_url:a.canonical_url,query:q,search_match:{id,title:best.title,artist:best.artist,score:best.s},api_album:{title:cleanText(data?.album_album||''),artist:cleanText(data?.album_artist||''),date:cleanText(data?.album_date||data?.date||''),track_count:tracks.length},tracks:tracks.map((t,i)=>({position:i+1,id:t?.id??null,permlink:t?.permlink||null,artist:t?.artist||null,title:t?.song||t?.title||null,photo:t?.photo||null}))};
    results.push(rec);console.log(JSON.stringify({album:a.canonical_url,match:rec.search_match,tracks:tracks.length,api_title:rec.api_album.title}));
  }catch(e){results.push({canonical_url:a.canonical_url,error:e.message});console.log(JSON.stringify({album:a.canonical_url,error:e.message}));}
}
const summary={selected:results.length,success:results.filter(x=>!x.error).length,errors:results.filter(x=>x.error).length,with_tracks:results.filter(x=>x.tracks?.length).length};
await fsp.writeFile(path.join(OUT,'results.json'),JSON.stringify(results,null,2));await fsp.writeFile(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2));console.log('SUMMARY '+JSON.stringify(summary));