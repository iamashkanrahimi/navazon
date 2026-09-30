import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { cleanText, normalizeText, sleep } from './utils.js';

const HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};
const BASE = 'https://play.radiojavan.com';
const MONTHS='Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec January February March April May June July August September October November December'.split(' ');

function decodeHtml(s='') {
  return String(s)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function stripTags(s='') { return cleanText(decodeHtml(String(s).replace(/<[^>]+>/g,' '))); }
function h1(html='') {
  const m=String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
}
function canonicalLink(html='', fallback='') {
  const patterns=[
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
    /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i,
  ];
  for(const re of patterns){ const m=html.match(re); if(m) return new URL(decodeHtml(m[1]),fallback||BASE).href; }
  return fallback || null;
}
function candidateArtistUrl(name='') {
  const encoded=encodeURIComponent(cleanText(name)).replace(/%20/g,'+');
  return `${BASE}/artist/${encoded}`;
}
function uniquePush(out,seen,value){ if(!value||seen.has(value))return;seen.add(value);out.push(value); }
function extractUrls(html='', type) {
  const out=[]; const seen=new Set();
  const prefix=`/${type}/`;
  const patterns=[/href=["']([^"']+)["']/gi,/\\?"href\\?":\\?"([^"\\]+)\\?"/gi,/https?:\\?\/\\?\/play\.radiojavan\.com\\?\/[^"'<> ]+/gi];
  for(const re of patterns){
    for(const m of html.matchAll(re)){
      let raw=m[1]||m[0];
      raw=decodeHtml(raw).replace(/\\\//g,'/').replace(/\\u0026/g,'&');
      try {
        const u=new URL(raw,BASE);
        if(u.origin===BASE && u.pathname.toLowerCase().startsWith(prefix)) uniquePush(out,seen,`${u.origin}${u.pathname}`);
      } catch {}
    }
  }
  return out;
}
function imageProxyOriginals(html='', kind='artist') {
  const out=[]; const seen=new Set();
  const add=(raw)=>{
    if(!raw)return;
    let s=decodeHtml(raw).replace(/\\u0026/g,'&').replace(/\\\//g,'/');
    for(let i=0;i<2;i++){ try{ const d=decodeURIComponent(s); if(d===s)break; s=d; }catch{break;} }
    try { const u=new URL(s,BASE); if(kind==='artist' ? u.pathname.includes('/static/artists/photos/') : u.pathname.includes('/static/mp3/')) uniquePush(out,seen,u.href); } catch {}
  };
  for(const m of html.matchAll(/[?&]url=([^&"'<> ]+)/gi)) add(m[1]);
  for(const m of html.matchAll(/https?(?::|%3A)(?:\\?\/|%2F){2}play\.radiojavan\.com(?:\\?\/|%2F)api(?:\\?\/|%2F)image-proxy(?:\\?\/|%2F)image(?:\\?\/|%2F)static(?:\\?\/|%2F)[^&"'<> ]+/gi)) add(m[0]);
  for(const m of html.matchAll(/(?:https?:\/\/play\.radiojavan\.com)?\/api\/image-proxy\/image\/static\/[^"'<> ]+/gi)) add(m[0]);
  return out;
}
function pageText(html='') {
  return stripTags(String(html).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' '));
}
function albumStats(html='') {
  const t=pageText(html); const songs=t.match(/\b(\d{1,3})\s+Songs?\b/i); const mins=t.match(/\b(\d{1,4})\s+mins?\b/i);
  const monthRe=new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})\\b`,'i');
  const date=t.match(monthRe);
  return { track_count:songs?Number(songs[1]):null,total_minutes:mins?Number(mins[1]):null,release_date_text:date?date[0]:null };
}

export class PageClient {
  constructor({delayMs=Number(process.env.RJ_PHASE2_DELAY_MS||1400),timeoutMs=Number(process.env.RJ_PHASE2_TIMEOUT_MS||20000),maxAttempts=Number(process.env.RJ_PHASE2_MAX_ATTEMPTS||3)}={}){
    this.delayMs=Math.max(250,delayMs);this.timeoutMs=Math.max(2000,timeoutMs);this.maxAttempts=Math.max(1,Math.min(5,maxAttempts));this.nextAt=0;
  }
  async pace(){const jitter=Math.floor(Math.random()*250);const w=Math.max(0,this.nextAt-Date.now())+jitter;if(w)await sleep(w);this.nextAt=Date.now()+this.delayMs;}
  async fetch(url){let last;for(let a=1;a<=this.maxAttempts;a++){
    await this.pace();const c=new AbortController();const timer=setTimeout(()=>c.abort(),this.timeoutMs);
    try{const r=await globalThis.fetch(url,{headers:HEADERS,redirect:'follow',signal:c.signal});const text=await r.text();if(!r.ok){const e=new Error(`HTTP ${r.status}`);e.status=r.status;throw e;}return {url:r.url,html:text,status:r.status,attempts:a};}
    catch(e){last=e;if([400,404,410,401,403].includes(Number(e.status||0))||a>=this.maxAttempts)break;await sleep(Math.min(15000,1000*(2**(a-1))));}
    finally{clearTimeout(timer);}
  }throw last||new Error('fetch failed');}
}

export async function resolveArtist(client,candidate,{deep=true}={}){
  const requested=candidateArtistUrl(candidate.candidate_name||candidate.key);
  const first=await client.fetch(requested);
  const name=h1(first.html);
  const keyExpected=normalizeText(candidate.key||candidate.candidate_name||'');
  const keyActual=normalizeText(name||'');
  if(!name || keyExpected!==keyActual) throw new Error(`artist identity mismatch expected=${candidate.key} actual=${name||'missing'}`);
  const canonical=canonicalLink(first.html,first.url);
  const pages=[first];
  if(deep){
    for(const suffix of ['/songs','/albums']){
      try{ pages.push(await client.fetch(`${canonical.replace(/\/$/,'')}${suffix}`)); }catch{}
    }
  }
  const joined=pages.map(x=>x.html).join('\n');
  const images=imageProxyOriginals(first.html,'artist');
  return {
    key:keyExpected,candidate_name:candidate.candidate_name,display_name:name,canonical_url:canonical,
    image_url:images[0]||null,
    song_urls:extractUrls(joined,'song'),album_urls:extractUrls(joined,'album'),video_urls:extractUrls(joined,'video'),
    related_artist_urls:extractUrls(joined,'artist').filter(u=>u!==canonical),
    sample_track_urls:candidate.sample_track_urls||[],attempts:pages.reduce((n,p)=>n+(p.attempts||1),0),pages_fetched:pages.length,
  };
}

export async function resolveAlbum(client,candidate){
  const page=await client.fetch(candidate.source_url||candidate.canonical_url);
  const title=h1(page.html);
  if(!title) throw new Error('album h1 missing');
  const canonical=canonicalLink(page.html,page.url);
  if(!new URL(canonical).pathname.toLowerCase().startsWith('/album/')) throw new Error(`album redirect not canonical: ${canonical}`);
  const images=imageProxyOriginals(page.html,'album');
  const stats=albumStats(page.html);
  return {
    source_url:candidate.source_url||null,canonical_url:canonical,title,title_farsi:candidate.title_farsi||null,
    candidate_title:candidate.title||null,candidate_artist:candidate.artist||null,
    cover_url:images[0]||candidate.cover_urls?.[0]||null,
    artist_urls:extractUrls(page.html,'artist'),song_urls:extractUrls(page.html,'song'),
    ...stats,known_track_ids:candidate.track_ids||[],track_refs:candidate.track_refs||[],attempts:page.attempts,
  };
}

export async function readGzipJsonl(file){const rows=[];const input=fs.createReadStream(file).pipe(zlib.createGunzip());const rl=readline.createInterface({input,crlfDelay:Infinity});for await(const line of rl)if(line.trim())rows.push(JSON.parse(line));return rows;}
export async function writeJsonl(file,rows){await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''));}
