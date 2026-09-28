# Navazon Cloud v1.1 — Deep Catalog

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
