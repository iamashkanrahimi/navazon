import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs, normalizeText } from './utils.js';

const args=parseArgs();
const artistsFile=path.resolve(args.artists);
const patchesFile=path.resolve(args.patches);
const outDir=path.resolve(args.out||'./out/spotify-patched-artists');
const expected=Number(args.expected||140);
await fsp.mkdir(outDir,{recursive:true});

async function readGz(file){
  const rows=[];
  const rl=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});
  for await(const line of rl) if(line.trim()) rows.push(JSON.parse(line));
  return rows;
}
async function writeGz(file,rows){
  return new Promise((resolve,reject)=>{
    const g=zlib.createGzip({level:9});
    const o=fs.createWriteStream(file);
    o.on('finish',resolve);o.on('error',reject);g.on('error',reject);
    g.pipe(o);for(const r of rows)g.write(JSON.stringify(r)+'\n');g.end();
  });
}
const artists=await readGz(artistsFile);
const patches=await readGz(patchesFile);
if(patches.length!==expected) throw new Error(`expected ${expected} strict patches, got ${patches.length}`);

const pmap=new Map();
for(const p of patches){
  if(!p.canonical_url) throw new Error('patch missing canonical_url');
  if(pmap.has(p.canonical_url)) throw new Error('duplicate patch canonical_url: '+p.canonical_url);
  if(Number(p.shared_track_count||0)<2) throw new Error('patch below 2-track threshold: '+p.canonical_url);
  if(p.image_kind!=='artist_profile') throw new Error('patch is not artist_profile: '+p.canonical_url);
  if(!/^https:\/\/image-cdn-ak\.spotifycdn\.com\/image\/ab676161/i.test(p.image_url||'')) {
    throw new Error('patch image is not Spotify artist-profile image: '+p.canonical_url);
  }
  pmap.set(p.canonical_url,p);
}

let applied=0;
const seen=new Set();
const audit=[];
const patched=artists.map(a=>{
  const p=pmap.get(a.canonical_url);
  if(!p) return a;
  seen.add(a.canonical_url);
  if(normalizeText(a.display_name||'')!==normalizeText(p.radiojavan_name||'')){
    throw new Error('artist name mismatch: '+a.canonical_url+' :: '+a.display_name+' != '+p.radiojavan_name);
  }
  if(!a.image_url) throw new Error('target artist has no current fallback image: '+a.canonical_url);
  const before={image_url:a.image_url,image_source:a.image_source||null,image_kind:a.image_kind||null};
  const out={...a};
  out.radiojavan_fallback_image_url=a.radiojavan_fallback_image_url||a.image_url;
  out.radiojavan_fallback_image_source=a.radiojavan_fallback_image_source||a.image_source||null;
  out.image_url=p.image_url;
  out.image_source='spotify_embed_artist_profile';
  out.image_kind='artist_profile';
  out.spotify_artist_id=p.spotify_id;
  out.spotify_artist_name=p.spotify_name;
  out.spotify_match_shared_track_count=Number(p.shared_track_count||0);
  out.spotify_match_shared_tracks=p.shared_tracks||[];
  out.spotify_direct_validation=p.direct_validation||null;
  out.spotify_direct_validated_track_count=Number(p.direct_validated_track_count||0);
  if(p.direct_validated_tracks) out.spotify_direct_validated_tracks=p.direct_validated_tracks;
  applied++;
  audit.push({canonical_url:a.canonical_url,display_name:a.display_name,before,after:{image_url:out.image_url,image_source:out.image_source,image_kind:out.image_kind,spotify_artist_id:out.spotify_artist_id,shared:out.spotify_match_shared_track_count,direct_validated:out.spotify_direct_validated_track_count},fallback_preserved:out.radiojavan_fallback_image_url});
  return out;
});
if(seen.size!==patches.length){
  const missing=[...pmap.keys()].filter(k=>!seen.has(k));
  throw new Error('patch targets missing from artist dataset: '+JSON.stringify(missing.slice(0,20)));
}
if(applied!==expected) throw new Error(`expected to apply ${expected}, applied ${applied}`);

const spotifyProfiles=patched.filter(a=>a.image_source==='spotify_embed_artist_profile');
if(spotifyProfiles.length!==expected) throw new Error(`expected ${expected} Spotify profile artists after patch, got ${spotifyProfiles.length}`);
const badBackup=spotifyProfiles.filter(a=>!a.radiojavan_fallback_image_url);
if(badBackup.length) throw new Error('Spotify-patched artists missing preserved Radio Javan fallback');

await writeGz(path.join(outDir,'rj-artists.jsonl.gz'),patched);
await fsp.writeFile(path.join(outDir,'spotify-artist-image-apply-audit.json'),JSON.stringify(audit,null,2));
await fsp.writeFile(path.join(outDir,'spotify-artist-image-apply-summary.json'),JSON.stringify({
  input_artists:artists.length,
  strict_patches:patches.length,
  applied,
  spotify_profile_artists:spotifyProfiles.length,
  fallbacks_preserved:spotifyProfiles.filter(a=>a.radiojavan_fallback_image_url).length
},null,2));
console.log(JSON.stringify({input_artists:artists.length,strict_patches:patches.length,applied,spotify_profile_artists:spotifyProfiles.length,fallbacks_preserved:spotifyProfiles.filter(a=>a.radiojavan_fallback_image_url).length},null,2));
