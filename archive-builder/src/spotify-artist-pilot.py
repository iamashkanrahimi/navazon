#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import html
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

UA = "NavazonSpotifyPilot/0.1 (+https://github.com/iamashkanrahimi/navazon)"

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

def http_text(url, attempts=3, timeout=45):
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
            if attempt < attempts:
                time.sleep(1.25 * attempt)
    raise last

def http_json(url, attempts=3):
    return json.loads(http_text(url, attempts=attempts))

def parse_letter_html(raw_html):
    out = defaultdict(list)
    rx = re.compile(
        r'<a\s+href=["\']https://www\.mystreamcount\.com/artist/([A-Za-z0-9]+)["\'][^>]*>\s*([\s\S]*?)\s*</a>',
        re.I,
    )
    for sid, inner in rx.findall(raw_html or ""):
        name = clean(html.unescape(re.sub(r"<[^>]+>", " ", inner)))
        key = norm_name(name)
        if key and sid not in [x["spotify_id"] for x in out[key]]:
            out[key].append({"spotify_id": sid, "indexed_name": name})
    return out

def parse_musicgroup(page):
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
        page,
        re.I,
    )
    groups = []
    for raw in blocks:
        try:
            obj = json.loads(html.unescape(raw))
        except Exception:
            continue
        candidates = obj if isinstance(obj, list) else [obj]
        for item in candidates:
            if isinstance(item, dict) and item.get("@type") in ("MusicGroup", "Person"):
                groups.append(item)
    if not groups:
        return None
    g = groups[0]
    tracks = []
    raw_tracks = g.get("track") or []
    if isinstance(raw_tracks, dict):
        raw_tracks = [raw_tracks]
    for t in raw_tracks:
        if isinstance(t, dict) and clean(t.get("name")):
            tracks.append(clean(t.get("name")))
    return {
        "name": clean(g.get("name")),
        "image": clean(g.get("image")) or None,
        "tracks": tracks,
    }

def parse_spotify_embed(page):
    m = re.search(
        r'<script id=["\']__NEXT_DATA__["\'] type=["\']application/json["\']>([\s\S]*?)</script>',
        page,
        re.I,
    )
    if not m:
        return None
    obj = json.loads(m.group(1))
    entity = (((obj.get("props") or {}).get("pageProps") or {}).get("state") or {}).get("data", {}).get("entity", {})
    name = clean(entity.get("name") or entity.get("title"))
    tracks = []
    for t in entity.get("trackList") or []:
        if clean(t.get("title")):
            tracks.append(clean(t.get("title")))
    images = (((entity.get("visualIdentity") or {}).get("image")) or [])
    images = [i for i in images if isinstance(i, dict) and clean(i.get("url"))]
    images.sort(key=lambda i: (int(i.get("maxWidth") or 0) * int(i.get("maxHeight") or 0)), reverse=True)
    return {
        "name": name,
        "tracks": tracks,
        "image": clean(images[0].get("url")) if images else None,
        "image_width": int(images[0].get("maxWidth") or 0) if images else None,
        "image_height": int(images[0].get("maxHeight") or 0) if images else None,
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
    rj_strict = defaultdict(list)
    rj_relaxed = defaultdict(list)
    for t in rj_titles:
        if norm_track_strict(t):
            rj_strict[norm_track_strict(t)].append(t)
        if norm_track_relaxed(t):
            rj_relaxed[norm_track_relaxed(t)].append(t)
    out = []
    seen = set()
    for st in spotify_titles:
        k1 = norm_track_strict(st)
        k2 = norm_track_relaxed(st)
        src = rj_strict.get(k1) or rj_relaxed.get(k2) or []
        if src:
            pair_key = (norm_track_relaxed(src[0]), norm_track_relaxed(st))
            if pair_key not in seen:
                seen.add(pair_key)
                out.append({"radiojavan": src[0], "spotify": st, "method": "strict" if rj_strict.get(k1) else "relaxed"})
    return out

def stable_hash(row):
    return hashlib.sha256((row.get("canonical_url") or row.get("display_name") or "").encode()).hexdigest()

def choose_sample(targets, total=100):
    eligible = [r for r in targets if re.match(r"^[A-Za-z]", clean(r.get("display_name")))]
    high = sorted(eligible, key=lambda r: (-int(r.get("track_count") or 0), norm_name(r.get("display_name")), r.get("canonical_url") or ""))[:40]
    used = {r.get("canonical_url") for r in high}
    medium_pool = [r for r in eligible if r.get("canonical_url") not in used and 2 <= int(r.get("track_count") or 0) <= 10]
    medium = sorted(medium_pool, key=stable_hash)[:30]
    used |= {r.get("canonical_url") for r in medium}
    single_pool = [r for r in eligible if r.get("canonical_url") not in used and int(r.get("track_count") or 0) == 1]
    single = sorted(single_pool, key=stable_hash)[:30]
    selected = [(r, "high") for r in high] + [(r, "medium") for r in medium] + [(r, "single") for r in single]
    if len(selected) < total:
        used |= {r.get("canonical_url") for r, _ in selected}
        rest = [r for r in eligible if r.get("canonical_url") not in used]
        selected += [(r, "fill") for r in sorted(rest, key=stable_hash)[:total-len(selected)]]
    return selected[:total], len(eligible)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sample-size", type=int, default=100)
    args = ap.parse_args()

    candidate = Path(args.candidate)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    artists = read_gz_jsonl(candidate / "rj-artists.jsonl.gz")
    tracks = read_gz_jsonl(candidate / "rj-tracks.jsonl.gz")
    targets = [a for a in artists if a.get("image_kind") == "track_art_fallback"]

    tracks_by_artist = defaultdict(set)
    tracks_by_slug = {}
    for t in tracks:
        title = clean(t.get("title"))
        if not title:
            continue
        for name in [t.get("artist_display")] + list(t.get("artist_names") or []) + list(t.get("artist_tags") or []):
            k = norm_name(name)
            if k:
                tracks_by_artist[k].add(title)
        for slug in [t.get("source_slug"), t.get("source_permalink")]:
            if slug:
                tracks_by_slug[clean(slug).lower()] = title

    sample, eligible_count = choose_sample(targets, args.sample_size)

    letters = sorted({clean(a.get("display_name"))[0].upper() for a, _ in sample if clean(a.get("display_name"))})
    name_index = defaultdict(list)
    letter_stats = {}
    for letter in letters:
        url = "https://www.mystreamcount.com/artists/letter/" + urllib.parse.quote(letter)
        try:
            data = http_json(url)
            parsed = parse_letter_html(data.get("html") or "")
            letter_stats[letter] = {"count": data.get("count"), "parsed_names": len(parsed), "error": None}
            for k, vals in parsed.items():
                name_index[k].extend(vals)
        except Exception as e:
            letter_stats[letter] = {"count": None, "parsed_names": 0, "error": repr(e)}
        time.sleep(0.25)

    rows = []
    page_cache = {}
    embed_cache = {}

    for idx, (artist, stratum) in enumerate(sample, 1):
        rj_name = clean(artist.get("display_name"))
        key = norm_name(rj_name)

        rj_titles = set(tracks_by_artist.get(key) or [])
        for raw_url in list(artist.get("song_urls") or []) + list(artist.get("sample_track_urls") or []):
            try:
                slug = urllib.parse.unquote(urllib.parse.urlparse(raw_url).path.rstrip("/").split("/")[-1]).lower()
                if slug in tracks_by_slug:
                    rj_titles.add(tracks_by_slug[slug])
            except Exception:
                pass

        candidates = name_index.get(key, [])
        evaluated = []
        for cand in candidates:
            sid = cand["spotify_id"]
            try:
                if sid not in page_cache:
                    page_cache[sid] = http_text("https://www.mystreamcount.com/artist/" + sid)
                    time.sleep(0.18)
                group = parse_musicgroup(page_cache[sid])
                if not group:
                    evaluated.append({"spotify_id": sid, "error": "musicgroup_missing", "shared": []})
                    continue
                if norm_name(group.get("name")) != key:
                    evaluated.append({"spotify_id": sid, "error": "indexed_name_identity_mismatch", "shared": []})
                    continue
                shared = shared_titles(sorted(rj_titles), group.get("tracks") or [])
                evaluated.append({
                    "spotify_id": sid,
                    "indexed_name": group.get("name"),
                    "indexed_image": group.get("image"),
                    "catalog_track_count": len(group.get("tracks") or []),
                    "shared": shared,
                    "error": None,
                })
            except Exception as e:
                evaluated.append({"spotify_id": sid, "error": "catalog_page_error:" + repr(e), "shared": []})

        evaluated.sort(key=lambda c: (-len(c.get("shared") or []), c.get("spotify_id") or ""))
        best = evaluated[0] if evaluated else None
        top_overlap = len(best.get("shared") or []) if best else 0
        tied = [c for c in evaluated if len(c.get("shared") or []) == top_overlap and top_overlap > 0]
        ambiguous = len(tied) > 1

        result = {
            "sample_index": idx,
            "stratum": stratum,
            "radiojavan_name": rj_name,
            "radiojavan_track_count": int(artist.get("track_count") or 0),
            "radiojavan_image_url": artist.get("image_url"),
            "radiojavan_track_titles_count": len(rj_titles),
            "exact_name_candidate_count": len(candidates),
            "status": None,
            "spotify_id": None,
            "spotify_name": None,
            "shared_tracks": [],
            "shared_track_count": 0,
            "spotify_image_url": None,
            "spotify_image_width": None,
            "spotify_image_height": None,
            "spotify_image_class": "none",
            "official_top_track_overlap": [],
            "error": None,
        }

        if not candidates:
            result["status"] = "name_not_found"
        elif not best or top_overlap == 0:
            result["status"] = "name_found_no_track_overlap"
        elif ambiguous:
            result["status"] = "ambiguous"
            result["shared_track_count"] = top_overlap
            result["shared_tracks"] = best.get("shared") or []
        else:
            sid = best["spotify_id"]
            result["spotify_id"] = sid
            result["shared_tracks"] = best.get("shared") or []
            result["shared_track_count"] = len(result["shared_tracks"])
            try:
                if sid not in embed_cache:
                    embed_cache[sid] = http_text("https://open.spotify.com/embed/artist/" + sid)
                    time.sleep(0.20)
                embed = parse_spotify_embed(embed_cache[sid])
                if not embed:
                    raise RuntimeError("spotify_embed_next_data_missing")
                result["spotify_name"] = embed.get("name")
                if norm_name(embed.get("name")) != key:
                    result["status"] = "official_name_mismatch"
                else:
                    result["spotify_image_url"] = embed.get("image") or best.get("indexed_image")
                    result["spotify_image_width"] = embed.get("image_width")
                    result["spotify_image_height"] = embed.get("image_height")
                    result["spotify_image_class"] = image_class(result["spotify_image_url"])
                    result["official_top_track_overlap"] = shared_titles(sorted(rj_titles), embed.get("tracks") or [])
                    if result["spotify_image_class"] == "artist_profile":
                        result["status"] = "confirmed_profile_image"
                    elif result["spotify_image_class"] == "cover_like":
                        result["status"] = "confirmed_but_cover_like"
                    else:
                        result["status"] = "confirmed_image_unknown_type"
            except Exception as e:
                result["status"] = "catalog_confirmed_spotify_embed_error"
                result["spotify_id"] = sid
                result["spotify_name"] = best.get("indexed_name")
                result["spotify_image_url"] = best.get("indexed_image")
                result["spotify_image_class"] = image_class(result["spotify_image_url"])
                result["error"] = repr(e)

        result["candidate_evaluations"] = evaluated
        rows.append(result)
        print(f"[{idx:03d}/{len(sample)}] {rj_name}: {result['status']} candidates={len(candidates)} shared={result['shared_track_count']} image={result['spotify_image_class']}", flush=True)

    counts = defaultdict(int)
    by_stratum = defaultdict(lambda: defaultdict(int))
    for r in rows:
        counts[r["status"]] += 1
        by_stratum[r["stratum"]][r["status"]] += 1

    exact_name_found = sum(1 for r in rows if r["exact_name_candidate_count"] > 0)
    confirmed = sum(1 for r in rows if r["status"] in {
        "confirmed_profile_image", "confirmed_but_cover_like", "confirmed_image_unknown_type"
    })
    profile = sum(1 for r in rows if r["status"] == "confirmed_profile_image")
    cover_like = sum(1 for r in rows if r["status"] == "confirmed_but_cover_like")
    direct_top_overlap = sum(1 for r in rows if r.get("official_top_track_overlap"))

    summary = {
        "pilot_version": 1,
        "target_pool_track_art_fallback": len(targets),
        "target_pool_latin_initial": eligible_count,
        "sample_size": len(rows),
        "sample_design": {
            "high": sum(1 for _, s in sample if s == "high"),
            "medium": sum(1 for _, s in sample if s == "medium"),
            "single": sum(1 for _, s in sample if s == "single"),
            "fill": sum(1 for _, s in sample if s == "fill"),
            "description": "40 highest-track-count + 30 deterministic artists with 2-10 RJ tracks + 30 deterministic single-track artists, all with Latin-letter English display names",
        },
        "matching_rule": "Exact normalized English artist name plus >=1 shared track title; ties are ambiguous. Official Spotify embed name must also match.",
        "exact_name_found": exact_name_found,
        "confirmed_by_name_and_shared_track": confirmed,
        "confirmed_profile_image": profile,
        "confirmed_but_cover_like": cover_like,
        "confirmed_image_unknown_type": counts["confirmed_image_unknown_type"],
        "official_embed_top_track_overlap": direct_top_overlap,
        "name_found_no_track_overlap": counts["name_found_no_track_overlap"],
        "name_not_found": counts["name_not_found"],
        "ambiguous": counts["ambiguous"],
        "official_name_mismatch": counts["official_name_mismatch"],
        "catalog_confirmed_spotify_embed_error": counts["catalog_confirmed_spotify_embed_error"],
        "status_counts": dict(sorted(counts.items())),
        "by_stratum": {k: dict(sorted(v.items())) for k, v in sorted(by_stratum.items())},
        "letter_index_stats": letter_stats,
    }

    (out_dir / "spotify-pilot-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out_dir / "spotify-pilot-results.jsonl").open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    (out_dir / "spotify-pilot-sample.json").write_text(
        json.dumps([
            {"name": clean(a.get("display_name")), "track_count": int(a.get("track_count") or 0), "stratum": s, "canonical_url": a.get("canonical_url")}
            for a, s in sample
        ], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("SUMMARY")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
