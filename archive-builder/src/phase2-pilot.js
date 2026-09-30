import fsp from 'node:fs/promises';
import path from 'node:path';
import { PageClient, resolveArtist, resolveAlbum, writeJsonl } from './phase2-pages.js';
import { parseArgs } from './utils.js';

const args=parseArgs();const inDir=path.resolve(args.in||'./runtime/phase2');const outDir=path.resolve(args.out||'./out/phase2-pilot');await fsp.mkdir(outDir,{recursive:true});
const read=async f=>(await fsp.readFile(path.join(inDir,f),'utf8')).split(/\n/).filter(Boolean).map(JSON.parse);
const artists=await read('artist-candidates.jsonl');const albums=await read('album-candidates.jsonl');
const artistNames=['koorosh','sami beigi','ebi','021kid','alireza jj','mr mp','homayoun shajarian','sogand'];
const selectedArtists=artistNames.map(n=>artists.find(x=>x.key===n)).filter(Boolean);
const albumTitles=['TEHRAN 2585','HOME ALONE','Khorshid Vol. 1 (Tolou)'];
const selectedAlbums=albumTitles.map(t=>albums.find(x=>x.title===t)).filter(Boolean);
const client=new PageClient({delayMs:Number(process.env.RJ_PHASE2_DELAY_MS||1200)});
const resolvedArtists=[],artistFailures=[];for(const a of selectedArtists){try{const r=await resolveArtist(client,a,{deep:true});resolvedArtists.push(r);console.log('ARTIST_OK',a.key,r.canonical_url,r.image_url,r.song_urls.length,r.album_urls.length);}catch(e){artistFailures.push({...a,error:e.message});console.log('ARTIST_FAIL',a.key,e.message);}}
const resolvedAlbums=[],albumFailures=[];for(const a of selectedAlbums){try{const r=await resolveAlbum(client,a);resolvedAlbums.push(r);console.log('ALBUM_OK',a.title,r.canonical_url,r.cover_url,r.song_urls.length,r.artist_urls.length);}catch(e){albumFailures.push({...a,error:e.message});console.log('ALBUM_FAIL',a.title,e.message);}}
await writeJsonl(path.join(outDir,'artists.jsonl'),resolvedArtists);await writeJsonl(path.join(outDir,'artist-failures.jsonl'),artistFailures);await writeJsonl(path.join(outDir,'albums.jsonl'),resolvedAlbums);await writeJsonl(path.join(outDir,'album-failures.jsonl'),albumFailures);
const summary={artists:{selected:selectedArtists.length,resolved:resolvedArtists.length,failed:artistFailures.length},albums:{selected:selectedAlbums.length,resolved:resolvedAlbums.length,failed:albumFailures.length}};
await fsp.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));if(artistFailures.length||albumFailures.length)process.exitCode=2;
