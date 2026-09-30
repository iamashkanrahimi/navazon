import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs } from './utils.js';

const args=parseArgs();
const input=path.resolve(args.in||'./runtime/artists/rj-artists.jsonl.gz');
const out=path.resolve(args.out||'./runtime/image-repair/candidates.jsonl');
const rows=[];
let total=0,withImage=0;
const rl=readline.createInterface({input:fs.createReadStream(input).pipe(zlib.createGunzip()),crlfDelay:Infinity});
for await(const line of rl){
  if(!line.trim()) continue;
  const row=JSON.parse(line); total++;
  if(row.image_url){withImage++;continue;}
  rows.push({
    canonical_url:row.canonical_url,
    key:row.key,
    candidate_name:row.candidate_name,
    display_name:row.display_name
  });
}
await fsp.mkdir(path.dirname(out),{recursive:true});
await fsp.writeFile(out,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''));
const summary={total_artists:total,already_with_image:withImage,repair_candidates:rows.length};
await fsp.writeFile(path.join(path.dirname(out),'plan-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));