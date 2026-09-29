# Navazon Cloud v1.4.4 — Reliability & Album Hardening

Cloud-ready Navazon Telegram music bot.

## Architecture

- Render Free Web Service: Telegram webhook + serialized source worker
- Neon Postgres: persistent catalog, Telegram file_id cache, follows, sessions and crawler queue
- Telegram MTProto proxy account: MeloBot Premium first, Ahangify fallback for user requests
- External cron: calls /crawler every 2 minutes

Audio and cover bytes are not stored in Render or Neon. Navazon stores Telegram file_id values plus metadata.

## Deep crawler

v1.1 uses a persistent, feed-driven task queue. It discovers content from MeloBot feeds:
- /new
- /topday
- /topweek
- /foreign
- /turkish
- /arabic

For every artist it stores recent and top tracks separately, then expands albums and album tracklists.

For every discovered track, separate tasks progressively collect HQ and normal Telegram file IDs, release date and popularity metadata, cover photo file IDs, and lyrics text when available.

Only one source task runs at a time. Crawl tasks are stored in Neon, so Render restarts do not lose the queue.

## Endpoints

- GET /health
- POST /telegram/webhook
- GET or POST /crawler with Bearer CRAWLER_TOKEN
- GET /admin/stats with Bearer ADMIN_TOKEN

/admin/stats includes deep catalog coverage for tracks, media qualities, covers, lyrics, release dates, albums, and queue state.


## Track pages

Selecting a song opens a compact song page instead of immediately downloading it.

- HQ and normal quality buttons are shown when available.
- Lyrics, cover, metadata, artist page, and album buttons are conditional.
- Album is shown only when the catalog has a verified album relation for that track.
- Artist pages expose both top tracks and newest tracks.
- Song choices inside top/newest/album lists also open the same song page.
- User-opened and user-searched tracks are promoted in the deep crawler queue so real usage improves the cache.


## Crawler v1.3

The crawler still runs at most one source stage per cron trigger and still waits for the configured user-idle window, but each stage now does more useful work.

- Fresh feeds are prioritized: /new every ~20 minutes and /topday every ~45 minutes.
- Artist pages persist recent and top tracks separately.
- MeloBot native bulk download buttons warm HQ and normal file IDs for recent/top lists and albums.
- Individual per-track downloads remain only as low-priority fallbacks.
- Metadata + cover + lyrics are bundled into one track enrichment stage instead of consuming three separate crawler turns.
- Home/category discovery explores more live MeloBot sections twice a day for broader long-tail discovery.
- Queue compaction retires superseded legacy metadata/cover/lyrics jobs.
- Bulk media cache writes automatically satisfy queued per-track media jobs.
- Database-only seeding uses small parallel batches.
- /admin/stats includes 24-hour productivity counters.

No new environment variables are required.


### Additional v1.3 optimizations

- Bulk downloads stop waiting as soon as the expected audio count arrives, with a short quiet fallback for partial source responses.
- Feed/artist/album tracks no longer create thousands of individual HQ/normal fallback jobs up front; native bulk gets first chance, and only real gaps become individual tasks.
- Artist and album bulk jobs are only queued when enough media is actually missing to justify a bulk redownload.
- Curated MeloBot playlists are explored daily as an additional long-tail discovery source.
- Batch-forwarded media is correlated back to tracks using title/artist metadata.
- Album/artist persistence and feed task creation use small parallel database batches to reduce Neon round trips.


## Home discovery v1.4

Navazon now has a compact first-page discovery menu:

- Newest: Iranian, foreign, Turkish, Arabic.
- Most downloaded: day and week.
- Curated playlists: Pop Selection, Yadegari, Remix, Martik, Gilaki.
- Followed artists: opens the user's existing follows directly.

The playlist menu is intentionally curated instead of mirroring every MeloBot playlist. Seasonal/noisy entries such as “قدر” are not exposed on Navazon's home page. Crawler-discovered feed and playlist tracks are reused as short-lived browse caches so home navigation usually avoids an extra source request.


## Album reliability v1.4.1

- Detects MeloBot pages that are already album listings instead of mistaking the first album row for an Albums navigation button.
- “Album + artist” searches resolve the artist picker directly and can return album-only results without requiring a seed track.
- Explicit album searches show album rows first and support common Persian spellings.
- Negative album caching is trusted only after MeloBot explicitly confirms zero albums; legacy false-empty cache/session state self-heals automatically.
- Album-search SQL bindings in both catalog stores are corrected.
- Album-only search results can open tracks and use native bulk album download without a prior track seed.
- The crawler now recognizes embedded album-list pages too.


## Reliability & album hardening v1.4.4

- Album listings follow MeloBot pagination instead of treating a partial first page as the whole discography.
- Album opening resets to a fresh artist page and navigates to the page that actually contains the requested album before clicking it.
- Persian half-space variants such as «آلبوم‌های» use the same canonical normalization as catalog and cache matching.
- Explicit album-title searches no longer fall back to showing every album when the requested title is missing.
- Busy interactive sessions stay alive long enough to survive a backed-up serialized source queue.
- Ahangify fallback is labeled as the best available source quality rather than implying a verified HQ bitrate.
- Confirmed empty album lists use a shorter default negative-cache TTL.
- CI now also runs on direct pushes to main.
