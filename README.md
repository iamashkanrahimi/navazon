# Navazon Cloud v1.3 — Agile Deep Catalog

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
