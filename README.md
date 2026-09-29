# Navazon Cloud v1.5.4 — Search Hardening & HQ Cache

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


## MeloBot navigation hardening v1.4.5

- Search now follows bounded multi-step MeloBot suggestion flows until a real track row is reached.
- Stateful searches may intentionally send the same visible label again when the source state changed.
- Artist-picker pages can resolve title-only track rows without treating navigation controls as songs.
- Album navigation recognizes more source labels and no longer misclassifies album controls as tracks.
- Album resolution shares one state-safe initial-listing path for browsing, opening, bulk downloads, and crawler work.
- Missing album buttons trigger a bounded recovery probe for late artist-page messages and secondary navigation.
- Artist-to-album resolution automatically retries through the direct source route before surfacing an error.
- Safe source-surface diagnostics record response text and reply-button labels for future MeloBot UI changes.


## Fast Path Architecture v1.5.0

- Replaces repeated `messages.GetHistory` polling with a buffered GramJS `NewMessage` inbox in production.
- Interactive jobs receive strict queue priority over discovery/crawler work.
- Heavy crawler media tasks require a much longer user-idle window and metadata crawls no longer download media inline.
- MeloBot track and album rows carry a live source-state token so immediate user actions can reuse the current source screen.
- Album opening can click the current live album row directly instead of repeating Search → Track → Artist → Albums.
- Album bulk download can reuse the current live album page and its native HQ bulk button.
- Event-driven response quiet windows are reduced from multi-second waits to sub-second settling.
- Source jobs emit `[perf]` timing logs with queue wait, run time, and total latency for before/after measurement.
- Polling remains as a compatibility fallback for tests or clients where the event inbox is not installed.


## Instant Search & Album Open v1.5.1

- Ordinary artist/track searches never perform hidden live album discovery; only explicit `album / آلبوم` queries may use the live discography path.
- Cached album rows open through a direct title-targeted MeloBot route instead of repeating Artist → Albums navigation.
- The direct title opener clicks the target while its reply-keyboard page is still live, including paginated discographies.
- If the quick direct route is unavailable, the robust fallback remains direct-first and performs at most one seed-navigation recovery path.
- Repeatedly failing primary Artist → Albums routes are circuit-broken per artist for 10 minutes to avoid paying the same timeout again.
- Search and album-open phase telemetry is emitted so live latency can be measured separately from queue time.


## Instant Albums List v1.5.2

- Reuses a still-live album control/listing from the exact artist source surface when safe.
- Falls back to a direct-first album listing route instead of paying the slow Artist → Albums timeout first.
- Only if direct-first fails does the existing primary route run, and its own direct retry is suppressed to avoid duplicate work.
- Album rows returned by the direct-first path remain live, so opening an album immediately afterward can use the existing current-listing fast path.
- Artist sorting now records the final source keyboard separately from stale base-page controls.
- Artist sort/navigation buttons are explicitly rejected by the track parser, preventing them from being mistaken for title-only songs.
- Adds dedicated Albums telemetry with route, cache time, source time, total time, and album count.


## Typed Search & Artist Recovery v1.5.3

- MeloBot search surfaces are parsed as typed track/album results instead of assuming every comma/dash row is a song.
- Disc-prefixed album rows are never parsed as tracks, including search rows without a track-count suffix.
- Exact low-confidence `artist + title` results are probed once while live; if MeloBot opens an album page, Navazon converts the result to an album and indexes its visible tracks immediately.
- Exact high-confidence track rows with source popularity metadata stay on the no-probe fast path.
- User search cache is namespaced for v1.5.3 so previously misclassified search rows do not survive the fix.
- Artist navigation detects when a selected search row opened an album and jumps through a real visible album track to the artist page instead of failing on a missing singer button.
- Artist navigation and sorting use bounded timeouts so a malformed source surface cannot hold the UI for ~18 seconds.
- Empty artist profiles fail closed and are never written over a healthy catalog artist context.
- Search telemetry now includes source, exact-probe outcome, track count, album count, and phase timing; artist telemetry includes route and recovered track counts.


## Search Hardening & HQ Cache v1.5.4

- Exact low-confidence track-like hits are probed even when the same search also contains album results, fixing mixed queries such as `shayea do be shak`.
- Probed album data is merged back without dropping visible tracklists, so album-only search results can open from indexed tracks immediately.
- Direct Artist shortcuts require at least two consistent MeloBot track rows; one ambiguous pseudo-track can no longer create a broken Artist-page button.
- Artist recovery accepts two exact-artist search rows even when MeloBot omits popularity counters, covering sparse artist surfaces without trusting a single ambiguous row.
- Search cache namespace is bumped to `v154` so bad mixed-search rows cached by earlier versions cannot survive the fix.
- Search-result albums open target-first through the direct album route instead of resolving a whole discography first.
- Followed-artist pages now reject stale/empty cached Artist contexts just like normal Artist pages.
- Native bulk downloads (album, top, recent) use only explicit `hq` rows from `deep_track_media` when served from cache; untyped legacy cache is never treated as HQ.
- Explicit single-track HQ requests also bypass untyped legacy cache, so the “quality عالی” label is quality-strict.
- Batched HQ cache lookup fetches all requested media in one database query to keep cached bulk delivery fast.
- Regression coverage includes mixed track+album queries, real low-confidence tracks, single-row Artist shortcuts, multi-row Artist recovery, Persian/Latin query shapes, counted albums, and quality-aware media lookup.
