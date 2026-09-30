#!/usr/bin/env python3
import argparse, concurrent.futures as futures, gzip, html, json, random, re, time, unicodedata, urllib.request, zipfile
from pathlib import Path

UA="NavazonSpotifyDirectQA/1.0 (+https://github.com/iamashkanrahimi/navazon)"

def clean(s): return " ".join(str(s or "").strip().split())
def norm(s):
    s=unicodedata.normalize("NFKC",clean(s)).lower().replace("’","'").replace(chr(96),"'").replace("´","'")
    s=re.sub(r"\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\b[^\)\]]*[\)\]]"," ",s,flags=re.I)
    s=re.sub(r"\s+-\s+(?:ft\.?|feat\.?|featuring)\b.*$"," ",s,flags=re.I)
    s=re.sub(r"\s*[\(\[]\s*(?:remix|radio edit|edit|live|acoustic|remastered|new version|version)\b[^\)\]]*[\)\]]"," ",s,flags=re.I)
    s=re.sub(r"\s+-\s+(?:remix|radio edit|edit|live|acoustic|remastered|new version|version)\b.*$"," ",s,flags=re.I)
    s=re.sub(r"[^a-z0-9]+"," ",s)
    return " ".join(s.split())

def http(url,attempts=4):
    last=None
    for a in range(1,attempts+1):
        try:
            req=urllib.request.Request(url,headers={"User-Agent":UA,"Accept-Language":"en-US,en;q=0.8"})
            with urllib.request.urlopen(req,timeout=40) as r:return r.read().decode("utf-8","replace")
        except Exception as e:
            last=e
            if getattr(e,"code",None) in (400,401,403,404,410): break
            if a<attempts: time.sleep(min(8,(1.2*(2**(a-1)))+random.random()))
    raise last

def read_gz(path):
    out=[]
    with gzip.open(path,"rt",encoding="utf-8") as f:
        for line in f:
            if line.strip(): out.append(json.loads(line))
    return out

def write_gz(path,rows):
    with gzip.open(path,"wt",encoding="utf-8",compresslevel=9) as f:
        for r in rows:f.write(json.dumps(r,ensure_ascii=False,separators=(",",":"))+"\n")

def track_links(page):
    out=[]
    seen=set()
    rx=re.compile(r'<a\b[^>]+href=["\'](?:https://www\.mystreamcount\.com)?/track/([A-Za-z0-9]+)["\'][^>]*>([\s\S]*?)</a>',re.I)
    for tid,inner in rx.findall(page or ""):
        txt=clean(html.unescape(re.sub(r"<[^>]+>"," ",inner)))
        if tid not in seen:
            seen.add(tid); out.append((tid,txt))
    return out

def parse_track_embed(page):
    m=re.search(r'<script id=["\']__NEXT_DATA__["\'] type=["\']application/json["\']>([\s\S]*?)</script>',page or "",re.I)
    if not m:return None
    obj=json.loads(m.group(1))
    entity=obj["props"]["pageProps"]["state"]["data"]["entity"]
    return {
        "title":clean(entity.get("title") or entity.get("name")),
        "artist_uris":[clean(a.get("uri")) for a in (entity.get("artists") or [])],
    }

def validate_row(r):
    sid=r["spotify_id"]
    expected=[clean(x.get("spotify") or x.get("radiojavan")) for x in (r.get("shared_tracks") or [])]
    expected=[x for x in expected if x]
    try:
        page=http("https://www.mystreamcount.com/artist/"+sid)
        links=track_links(page)
    except Exception as e:
        return {"canonical_url":r["canonical_url"],"passed":False,"validated":[],"error":"catalog_fetch:"+repr(e)}
    validated=[]
    used=set()
    for title in expected:
        nt=norm(title)
        if not nt: continue
        candidates=[]
        for tid,txt in links:
            ntext=norm(txt)
            if tid in used: continue
            if ntext==nt or ntext.startswith(nt+" ") or nt in ntext[:max(len(nt)+12,len(nt))]:
                candidates.append((tid,txt))
        for tid,txt in candidates[:3]:
            try:
                ent=parse_track_embed(http("https://open.spotify.com/embed/track/"+tid))
                if not ent: continue
                if norm(ent["title"])!=nt: continue
                if "spotify:artist:"+sid not in ent["artist_uris"]: continue
                used.add(tid)
                validated.append({"spotify_track_id":tid,"expected_title":title,"spotify_title":ent["title"]})
                break
            except Exception:
                continue
        if len(validated)>=2: break
    return {"canonical_url":r["canonical_url"],"passed":len(validated)>=2,"validated":validated,"error":None}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-dir",required=True)
    ap.add_argument("--out",required=True)
    ap.add_argument("--workers",type=int,default=6)
    args=ap.parse_args()
    inp=Path(args.input_dir); out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    results=read_gz(inp/"spotify-full-results.jsonl.gz")
    patches=read_gz(inp/"spotify-artist-image-patches.jsonl.gz")
    patch_by={p["canonical_url"]:p for p in patches}
    profile=[r for r in results if r.get("status")=="confirmed_profile_image"]
    already=[r for r in profile if int(r.get("direct_embed_shared_count") or 0)>=2]
    need=[r for r in profile if int(r.get("direct_embed_shared_count") or 0)<2]
    checked=[]
    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        fm={pool.submit(validate_row,r):r for r in need}
        for i,f in enumerate(futures.as_completed(fm),1):
            r=fm[f]
            try:q=f.result()
            except Exception as e:q={"canonical_url":r["canonical_url"],"passed":False,"validated":[],"error":repr(e)}
            checked.append(q)
            print(f"[{i}/{len(need)}] {r['radiojavan_name']}: {'PASS' if q['passed'] else 'REVIEW'} validated={len(q['validated'])}",flush=True)
    qa={x["canonical_url"]:x for x in checked}
    strict=[]
    review=[]
    for r in profile:
        if int(r.get("direct_embed_shared_count") or 0)>=2:
            p=patch_by[r["canonical_url"]].copy()
            p["direct_validation"]="artist_embed_top_tracks"
            p["direct_validated_track_count"]=int(r.get("direct_embed_shared_count") or 0)
            strict.append(p)
        else:
            q=qa.get(r["canonical_url"],{})
            if q.get("passed"):
                p=patch_by[r["canonical_url"]].copy()
                p["direct_validation"]="individual_spotify_track_embeds"
                p["direct_validated_track_count"]=len(q.get("validated") or [])
                p["direct_validated_tracks"]=q.get("validated") or []
                strict.append(p)
            else:
                review.append({"artist":r,"qa":q})
    strict.sort(key=lambda x:x["canonical_url"])
    write_gz(out/"spotify-artist-image-patches-strict.jsonl.gz",strict)
    (out/"spotify-direct-review.json").write_text(json.dumps(review,ensure_ascii=False,indent=2),encoding="utf-8")
    summary={
        "profile_candidates_before_direct_qa":len(profile),
        "already_two_plus_direct_top_tracks":len(already),
        "needed_individual_track_validation":len(need),
        "passed_individual_track_validation":sum(1 for q in checked if q.get("passed")),
        "manual_review_or_rejected":len(review),
        "strict_profile_patches":len(strict),
    }
    (out/"spotify-direct-qa-summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False,indent=2))
if __name__=="__main__":main()
