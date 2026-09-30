#!/usr/bin/env python3
import argparse
import concurrent.futures as futures
import gzip
import hashlib
import html
import json
import random
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

UA = "NavazonSpotifyRecovery/1.0 (+https://github.com/iamashkanrahimi/navazon)"
MIN_SHARED = 2
MAX_CANDIDATES_PER_NAME = 20

def clean(s):
    return " ".join(str(s or "").strip().split())

def norm_name(s):
    s = unicodedata.normalize("NFKC", clean(s)).lower()
    s = s.replace("’", "'").replace(chr(96), "'").replace("´", "'")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())

def norm_track_strict(s):
    s = unicodedata.normalize("NFKC", clean(s)).lower()
    s = s.replace("’", "'").replace(chr(96), "'").replace("´", "'")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())

def norm_track_relaxed(s):
    s = clean(s)
    s = re.sub(r"\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\b[^\)\]]*[\)\]]", " ", s, flags=re.I)
    s = re.sub(r"\s+-\s+(?:ft\.?|feat\.?|featuring)\b.*$", " ", s, flags=re.I)
    s = re.sub(r"\s*[\(\[]\s*(?:remix|radio edit|edit|live|acoustic|remastered|new version|version)\b[^\)\]]*[\)\]]", " ", s, flags=re.I)
    s = re.sub(r"\s+-\s+(?:remix|radio edit|edit|live|acoustic|remastered|new version|version)\b.*$", " ", s, flags=re.I)
    return norm_track_strict(s)

def read_gz_jsonl(path):
    rows = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows

def write_gz_jsonl(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

def http_text(url, attempts=4, timeout=45):
    last = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            code = getattr(e, "code", None)
            if code in (400, 401, 403, 404, 410):
                break
            if attempt < attempts:
                time.sleep(min(12.0, (1.2 * (2 ** (attempt - 1))) + random.random()))
    raise last

def http_json(url, attempts=4):
    return json.loads(http_text(url, attempts=attempts))

def parse_letter_html(raw_html, wanted_keys):
    out = defaultdict(list)
    rx = re.compile(
        r'<a\s+href=["\']https://www\.mystreamcount\.com/artist/([A-Za-z0-9]+)["\'][^>]*>\s*([\s\S]*?)\s*</a>',
        re.I,
    )
    seen = defaultdict(set)
    for sid, inner in rx.findall(raw_html or ""):
        name = clean(html.unescape(re.sub(r"<[^>]+>", " ", inner)))
        key = norm_name(name)
        if key not in wanted_keys or sid in seen[key]:
            continue
        seen[key].add(sid)
        out[key].append({"spotify_id": sid, "indexed_name": name})
    return out

def parse_catalog_tracks(page):
    # Prefer LD+JSON, then fall back to visible artist-page song links.
    groups = []
    for raw in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
        page or "",
        re.I,
    ):
        try:
            obj = json.loads(html.unescape(raw))
        except Exception:
            continue
        candidates = obj if isinstance(obj, list) else [obj]
        for item in candidates:
            if isinstance(item, dict) and item.get("@type") in ("MusicGroup", "Person"):
                groups.append(item)
    if groups:
        g = groups[0]
        tracks = []
        raw_tracks = g.get("track") or []
        if isinstance(raw_tracks, dict):
            raw_tracks = [raw_tracks]
        for t in raw_tracks:
            if isinstance(t, dict) and clean(t.get("name")):
                tracks.append(clean(t.get("name")))
        if tracks:
            return clean(g.get("name")), tracks

    title = None
    m = re.search(r"<h1\b[^>]*>([\s\S]*?)</h1>", page or "", re.I)
    if m:
        title = clean(html.unescape(re.sub(r"<[^>]+>", " ", m.group(1))))
    tracks = []
    for m in re.finditer(r'<a\b[^>]+href=["\'][^"\']*?/track/[^"\']+["\'][^>]*>([\s\S]*?)</a>', page or "", re.I):
        txt = clean(html.unescape(re.sub(r"<[^>]+>", " ", m.group(1))))
        if txt:
            tracks.append(txt)
    return title, tracks

def parse_spotify_embed(page):
    m = re.search(
        r'<script id=["\']__NEXT_DATA__["\'] type=["\']application/json["\']>([\s\S]*?)</script>',
        page or "",
        re.I,
    )
    if not m:
        return None
    obj = json.loads(m.group(1))
    state = (((obj.get("props") or {}).get("pageProps") or {}).get("state") or {})
    entity = (state.get("data") or {}).get("entity") or {}
    name = clean(entity.get("name") or entity.get("title"))
    tracks = [clean(t.get("title")) for t in (entity.get("trackList") or []) if clean(t.get("title"))]
    images = [i for i in ((entity.get("visualIdentity") or {}).get("image") or [])
              if isinstance(i, dict) and clean(i.get("url"))]
    images.sort(key=lambda i: int(i.get("maxWidth") or 0) * int(i.get("maxHeight") or 0), reverse=True)
    best = images[0] if images else {}
    return {
        "name": name,
        "tracks": tracks,
        "image": clean(best.get("url")) or None,
        "image_width": int(best.get("maxWidth") or 0) or None,
        "image_height": int(best.get("maxHeight") or 0) or None,
    }

def image_class(url):
    u = (url or "").lower()
    if not u:
        return "none"
    if "ab676161" in u:
        return "artist_profile"
    if "ab67616d" in u:
        return "cover_like"
    return "unknown"

def shared_titles(rj_titles, spotify_titles):
    strict = defaultdict(list)
    relaxed = defaultdict(list)
    for title in rj_titles:
        a = norm_track_strict(title)
        b = norm_track_relaxed(title)
        if a:
            strict[a].append(title)
        if b:
            relaxed[b].append(title)
    hits = []
    used = set()
    for st in spotify_titles:
        k1 = norm_track_strict(st)
        k2 = norm_track_relaxed(st)
        src = strict.get(k1) or relaxed.get(k2) or []
        if not src:
            continue
        identity = norm_track_relaxed(src[0])
        if not identity or identity in used:
            continue
        used.add(identity)
        hits.append({
            "radiojavan": src[0],
            "spotify": st,
            "method": "strict" if strict.get(k1) else "relaxed",
        })
    return hits

def stable_partition(value, shards):
    h = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return int(h[:12], 16) % shards

def build_rj_tracks(tracks):
    by_artist = defaultdict(set)
    for t in tracks:
        title = clean(t.get("title"))
        if not title:
            continue
        names = [t.get("artist_display")] + list(t.get("artist_names") or []) + list(t.get("artist_tags") or [])
        for name in names:
            key = norm_name(name)
            if key:
                by_artist[key].add(title)
    return by_artist

def cmd_prepare(args):
    candidate = Path(args.candidate)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    artists = read_gz_jsonl(candidate / "rj-artists.jsonl.gz")
    tracks = read_gz_jsonl(candidate / "rj-tracks.jsonl.gz")
    targets = [a for a in artists if a.get("image_kind") == "track_art_fallback"]
    by_artist = build_rj_tracks(tracks)

    prepared = []
    wanted_by_letter = defaultdict(set)
    for a in targets:
        name = clean(a.get("display_name"))
        key = norm_name(name)
        titles = sorted(by_artist.get(key) or [])
        track_count = int(a.get("track_count") or 0)
        row = {
            "canonical_url": a.get("canonical_url"),
            "radiojavan_name": name,
            "name_key": key,
            "radiojavan_image_url": a.get("image_url"),
            "radiojavan_track_count": track_count,
            "reference_titles": titles,
            "reference_title_count": len(titles),
            "candidate_ids": [],
            "pre_status": "pending",
        }
        if track_count < MIN_SHARED or len(titles) < MIN_SHARED:
            row["pre_status"] = "insufficient_rj_reference_tracks"
        elif not re.match(r"^[A-Za-z]", name):
            row["pre_status"] = "no_latin_english_name"
        else:
            wanted_by_letter[name[0].upper()].add(key)
        prepared.append(row)

    index = defaultdict(list)
    letter_stats = {}
    for letter in sorted(wanted_by_letter):
        url = "https://www.mystreamcount.com/artists/letter/" + urllib.parse.quote(letter)
        try:
            data = http_json(url)
            parsed = parse_letter_html(data.get("html") or "", wanted_by_letter[letter])
            for k, vals in parsed.items():
                index[k].extend(vals)
            letter_stats[letter] = {
                "source_count": data.get("count"),
                "wanted_names": len(wanted_by_letter[letter]),
                "matched_names": len(parsed),
                "error": None,
            }
        except Exception as e:
            letter_stats[letter] = {
                "source_count": None,
                "wanted_names": len(wanted_by_letter[letter]),
                "matched_names": 0,
                "error": repr(e),
            }
        time.sleep(0.30)

    for row in prepared:
        if row["pre_status"] != "pending":
            continue
        vals = []
        seen = set()
        for c in index.get(row["name_key"], []):
            sid = clean(c.get("spotify_id"))
            if sid and sid not in seen:
                seen.add(sid)
                vals.append(c)
        row["candidate_ids"] = vals
        if not vals:
            row["pre_status"] = "name_not_found"
        elif len(vals) > MAX_CANDIDATES_PER_NAME:
            row["pre_status"] = "too_many_exact_name_candidates"

    write_gz_jsonl(out / "spotify-full-prepared.jsonl.gz", prepared)
    counts = Counter(r["pre_status"] for r in prepared)
    summary = {
        "version": 1,
        "min_shared_tracks": MIN_SHARED,
        "target_pool": len(targets),
        "eligible_by_artist_track_count": sum(1 for r in prepared if r["radiojavan_track_count"] >= MIN_SHARED),
        "eligible_with_2_reference_titles": sum(1 for r in prepared if r["reference_title_count"] >= MIN_SHARED),
        "pending_exact_name_candidates": counts["pending"],
        "pre_status_counts": dict(sorted(counts.items())),
        "letter_stats": letter_stats,
    }
    (out / "spotify-full-prepare-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

_thread_local = threading.local()

def evaluate_candidate(target, candidate):
    sid = candidate["spotify_id"]
    key = target["name_key"]
    errors = []
    embed = None
    catalog_name = None
    catalog_tracks = []

    try:
        embed_page = http_text("https://open.spotify.com/embed/artist/" + sid)
        embed = parse_spotify_embed(embed_page)
        if not embed:
            return {"spotify_id": sid, "valid_name": False, "shared": [], "error": "embed_next_data_missing"}
        if norm_name(embed.get("name")) != key:
            return {
                "spotify_id": sid,
                "spotify_name": embed.get("name"),
                "valid_name": False,
                "shared": [],
                "error": "official_name_mismatch",
            }
    except Exception as e:
        return {"spotify_id": sid, "valid_name": False, "shared": [], "error": "spotify_embed_error:" + repr(e)}

    try:
        catalog_page = http_text("https://www.mystreamcount.com/artist/" + sid)
        catalog_name, catalog_tracks = parse_catalog_tracks(catalog_page)
        if catalog_name and norm_name(catalog_name) != key:
            errors.append("catalog_name_mismatch")
    except Exception as e:
        errors.append("catalog_page_error:" + repr(e))

    direct_hits = shared_titles(target["reference_titles"], embed.get("tracks") or [])
    catalog_hits = shared_titles(target["reference_titles"], catalog_tracks)
    merged = []
    used = set()
    for hit in direct_hits + catalog_hits:
        ident = norm_track_relaxed(hit["radiojavan"])
        if ident and ident not in used:
            used.add(ident)
            merged.append(hit)

    return {
        "spotify_id": sid,
        "spotify_name": embed.get("name"),
        "valid_name": True,
        "shared": merged,
        "shared_count": len(merged),
        "direct_embed_shared": direct_hits,
        "catalog_shared": catalog_hits,
        "spotify_image_url": embed.get("image"),
        "spotify_image_width": embed.get("image_width"),
        "spotify_image_height": embed.get("image_height"),
        "spotify_image_class": image_class(embed.get("image")),
        "error": ";".join(errors) if errors else None,
    }

def evaluate_target(target):
    candidates = target.get("candidate_ids") or []
    if not candidates:
        return None
    evaluations = []
    for candidate in candidates:
        evaluations.append(evaluate_candidate(target, candidate))
        time.sleep(0.04 + random.random() * 0.04)

    valid = [e for e in evaluations if e.get("valid_name")]
    valid.sort(key=lambda e: (-int(e.get("shared_count") or 0), e.get("spotify_id") or ""))
    best = valid[0] if valid else None
    best_overlap = int(best.get("shared_count") or 0) if best else 0
    ties = [e for e in valid if int(e.get("shared_count") or 0) == best_overlap] if best_overlap >= MIN_SHARED else []

    result = {
        "canonical_url": target["canonical_url"],
        "radiojavan_name": target["radiojavan_name"],
        "radiojavan_track_count": target["radiojavan_track_count"],
        "reference_title_count": target["reference_title_count"],
        "status": None,
        "spotify_id": None,
        "spotify_name": None,
        "shared_track_count": best_overlap,
        "shared_tracks": best.get("shared") if best else [],
        "direct_embed_shared_count": len(best.get("direct_embed_shared") or []) if best else 0,
        "spotify_image_url": best.get("spotify_image_url") if best else None,
        "spotify_image_width": best.get("spotify_image_width") if best else None,
        "spotify_image_height": best.get("spotify_image_height") if best else None,
        "spotify_image_class": best.get("spotify_image_class") if best else "none",
        "error": best.get("error") if best else None,
        "candidate_count": len(candidates),
        "candidate_evaluations": evaluations,
    }

    if not valid:
        result["status"] = "all_candidates_failed_identity_or_fetch"
    elif best_overlap < MIN_SHARED:
        result["status"] = "name_found_lt2_shared_tracks"
    elif len(ties) > 1:
        result["status"] = "ambiguous_top_overlap"
    else:
        result["spotify_id"] = best["spotify_id"]
        result["spotify_name"] = best.get("spotify_name")
        if best.get("spotify_image_class") == "artist_profile":
            result["status"] = "confirmed_profile_image"
        elif best.get("spotify_image_class") == "cover_like":
            result["status"] = "confirmed_but_cover_like"
        elif best.get("spotify_image_class") == "none":
            result["status"] = "confirmed_no_image"
        else:
            result["status"] = "confirmed_image_unknown_type"
    return result

def cmd_shard(args):
    rows = read_gz_jsonl(args.input)
    selected = [
        r for r in rows
        if r.get("pre_status") == "pending"
        and stable_partition(r.get("canonical_url") or r.get("radiojavan_name") or "", args.shards) == args.shard
    ]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"shard={args.shard}/{args.shards} selected={len(selected)} workers={args.workers}", flush=True)

    results = []
    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        future_map = {pool.submit(evaluate_target, r): r for r in selected}
        done = 0
        for fut in futures.as_completed(future_map):
            target = future_map[fut]
            done += 1
            try:
                result = fut.result()
            except Exception as e:
                result = {
                    "canonical_url": target["canonical_url"],
                    "radiojavan_name": target["radiojavan_name"],
                    "radiojavan_track_count": target["radiojavan_track_count"],
                    "reference_title_count": target["reference_title_count"],
                    "status": "worker_exception",
                    "spotify_id": None,
                    "spotify_name": None,
                    "shared_track_count": 0,
                    "shared_tracks": [],
                    "direct_embed_shared_count": 0,
                    "spotify_image_url": None,
                    "spotify_image_class": "none",
                    "error": repr(e),
                    "candidate_count": len(target.get("candidate_ids") or []),
                    "candidate_evaluations": [],
                }
            if result is not None:
                results.append(result)
                print(
                    f"[{done}/{len(selected)}] {result['radiojavan_name']}: "
                    f"{result['status']} shared={result['shared_track_count']} candidates={result['candidate_count']}",
                    flush=True,
                )

    results.sort(key=lambda r: r["canonical_url"] or "")
    write_gz_jsonl(out / f"spotify-full-shard-{args.shard:02d}.jsonl.gz", results)
    counts = Counter(r["status"] for r in results)
    summary = {
        "shard": args.shard,
        "shards": args.shards,
        "workers": args.workers,
        "selected": len(selected),
        "result_count": len(results),
        "status_counts": dict(sorted(counts.items())),
    }
    (out / f"spotify-full-shard-{args.shard:02d}-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if len(results) != len(selected):
        raise SystemExit("shard result cardinality mismatch")

def all_files(root, suffix):
    return sorted(p for p in Path(root).rglob("*") if p.is_file() and p.name.endswith(suffix))

def cmd_merge(args):
    prepared = read_gz_jsonl(args.prepared)
    result_files = all_files(args.shard_dir, ".jsonl.gz")
    shard_results = []
    for file in result_files:
        if "spotify-full-shard-" in file.name:
            shard_results.extend(read_gz_jsonl(file))
    result_map = {r["canonical_url"]: r for r in shard_results}

    final = []
    for p in prepared:
        if p["pre_status"] != "pending":
            final.append({
                "canonical_url": p["canonical_url"],
                "radiojavan_name": p["radiojavan_name"],
                "radiojavan_track_count": p["radiojavan_track_count"],
                "reference_title_count": p["reference_title_count"],
                "status": p["pre_status"],
                "spotify_id": None,
                "spotify_name": None,
                "shared_track_count": 0,
                "shared_tracks": [],
                "direct_embed_shared_count": 0,
                "spotify_image_url": None,
                "spotify_image_class": "none",
                "error": None,
                "candidate_count": len(p.get("candidate_ids") or []),
            })
        else:
            r = result_map.get(p["canonical_url"])
            if not r:
                final.append({
                    "canonical_url": p["canonical_url"],
                    "radiojavan_name": p["radiojavan_name"],
                    "radiojavan_track_count": p["radiojavan_track_count"],
                    "reference_title_count": p["reference_title_count"],
                    "status": "missing_shard_result",
                    "spotify_id": None,
                    "spotify_name": None,
                    "shared_track_count": 0,
                    "shared_tracks": [],
                    "direct_embed_shared_count": 0,
                    "spotify_image_url": None,
                    "spotify_image_class": "none",
                    "error": "no shard result",
                    "candidate_count": len(p.get("candidate_ids") or []),
                })
            else:
                final.append(r)

    final.sort(key=lambda r: r["canonical_url"] or "")
    patches = []
    for r in final:
        if r["status"] != "confirmed_profile_image":
            continue
        if int(r.get("shared_track_count") or 0) < MIN_SHARED:
            raise SystemExit("unsafe patch below shared-track threshold: " + str(r.get("canonical_url")))
        if norm_name(r.get("radiojavan_name")) != norm_name(r.get("spotify_name")):
            raise SystemExit("unsafe patch name mismatch: " + str(r.get("canonical_url")))
        patches.append({
            "canonical_url": r["canonical_url"],
            "radiojavan_name": r["radiojavan_name"],
            "spotify_id": r["spotify_id"],
            "spotify_name": r["spotify_name"],
            "image_url": r["spotify_image_url"],
            "image_source": "spotify_embed_artist_profile",
            "image_kind": "artist_profile",
            "shared_track_count": r["shared_track_count"],
            "shared_tracks": r["shared_tracks"],
        })

    candidate = Path(args.candidate)
    artists = read_gz_jsonl(candidate / "rj-artists.jsonl.gz")
    patch_map = {p["canonical_url"]: p for p in patches}
    patched_artists = []
    for a in artists:
        p = patch_map.get(a.get("canonical_url"))
        if p:
            a = dict(a)
            a["radiojavan_fallback_image_url"] = a.get("image_url")
            a["image_url"] = p["image_url"]
            a["image_source"] = p["image_source"]
            a["image_kind"] = p["image_kind"]
            a["spotify_artist_id"] = p["spotify_id"]
            a["spotify_match_shared_track_count"] = p["shared_track_count"]
        patched_artists.append(a)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_gz_jsonl(out / "spotify-full-results.jsonl.gz", final)
    write_gz_jsonl(out / "spotify-artist-image-patches.jsonl.gz", patches)
    write_gz_jsonl(out / "rj-artists.spotify-candidate.jsonl.gz", patched_artists)

    counts = Counter(r["status"] for r in final)
    confirmed_any = sum(counts[s] for s in (
        "confirmed_profile_image",
        "confirmed_but_cover_like",
        "confirmed_no_image",
        "confirmed_image_unknown_type",
    ))
    summary = {
        "version": 1,
        "min_shared_tracks": MIN_SHARED,
        "target_pool": len(prepared),
        "processed_pending": len(shard_results),
        "accounted_total": len(final),
        "confirmed_unique_match_ge2_tracks": confirmed_any,
        "usable_profile_image_patches": len(patches),
        "confirmed_but_cover_like": counts["confirmed_but_cover_like"],
        "confirmed_no_image": counts["confirmed_no_image"],
        "confirmed_image_unknown_type": counts["confirmed_image_unknown_type"],
        "status_counts": dict(sorted(counts.items())),
    }
    (out / "spotify-full-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if len(prepared) != 8312:
        raise SystemExit(f"target pool changed unexpectedly: expected 8312, got {len(prepared)}")
    if len(final) != len(prepared):
        raise SystemExit("final cardinality mismatch")
    if counts["missing_shard_result"]:
        raise SystemExit(f"missing shard results: {counts['missing_shard_result']}")
    if counts["worker_exception"]:
        raise SystemExit(f"worker exceptions: {counts['worker_exception']}")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("prepare")
    p.add_argument("--candidate", required=True)
    p.add_argument("--out", required=True)

    s = sub.add_parser("shard")
    s.add_argument("--input", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--shard", type=int, required=True)
    s.add_argument("--shards", type=int, required=True)
    s.add_argument("--workers", type=int, default=3)

    m = sub.add_parser("merge")
    m.add_argument("--candidate", required=True)
    m.add_argument("--prepared", required=True)
    m.add_argument("--shard-dir", required=True)
    m.add_argument("--out", required=True)

    args = ap.parse_args()
    if args.cmd == "prepare":
        cmd_prepare(args)
    elif args.cmd == "shard":
        cmd_shard(args)
    else:
        cmd_merge(args)

if __name__ == "__main__":
    main()
