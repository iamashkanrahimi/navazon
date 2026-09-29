# Navazon Cloud v1.6.1 — Catalog & Cache Repair

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

- Exact low-confidence track-like hits are probed even when the same search also contains album results, fixing mixed queries such as `shayea do be shak`. A same-name Track+Album collision is probed even if the track row has a popularity metric.
- Probed album data is merged back without dropping visible tracklists, so album-only search results can open from indexed tracks immediately.
- Explicit track-icon rows with parenthesized titles (for example `Song (2024)`) stay tracks instead of being mistaken for counted album rows.
- Direct Artist shortcuts require at least two consistent MeloBot track rows; one ambiguous pseudo-track can no longer create a broken Artist-page button.
- When search results contain albums from one unambiguous artist, Navazon still offers a safe Artist-page shortcut that opens from the album artist (and prefers a live visible album track when available).
- Artist recovery accepts two exact-artist search rows even when MeloBot omits popularity counters, covering sparse artist surfaces without trusting a single ambiguous row.
- Search cache namespace is bumped to `v154` so bad mixed-search rows cached by earlier versions cannot survive the fix.
- Search-result albums open target-first through the direct album route instead of resolving a whole discography first.
- Followed-artist pages now reject stale/empty cached Artist contexts just like normal Artist pages.
- Native bulk downloads (album, top, recent) use only explicit `hq` rows from `deep_track_media` when served from cache; untyped legacy cache is never treated as HQ.
- Media rows now carry a `verified_quality` provenance flag. Existing pre-v1.5.4 rows migrate as unverified and are ignored for quality-labelled delivery until MeloBot refreshes them; every new HQ/normal source fetch is stored as verified.
- The crawler treats unverified legacy media as missing and can revive completed media tasks, gradually rebuilding a trustworthy quality-aware cache.
- Explicit single-track HQ requests also bypass untyped legacy cache, so the “quality عالی” label is quality-strict.
- Batched HQ cache lookup fetches all requested media in one database query to keep cached bulk delivery fast.
- Regression coverage includes mixed track+album queries, real low-confidence tracks, single-row Artist shortcuts, multi-row Artist recovery, Persian/Latin query shapes, counted albums, and quality-aware media lookup.


## Bulk Fail-Fast & Queue Guard v1.5.5

- Fixes a production queue stall where a failed native album bulk download could occupy the single MeloBot source lane for about six minutes.
- Interactive bulk waits are capped to 12s on the first attempt and 18s on the optional retry; the generic bulk collector is capped at 30s instead of 180s.
- Bulk album/top/recent jobs now have lower queue priority than search/navigation work, so queued searches jump ahead before a batch starts.
- If a bulk attempt fails while foreground source work is waiting, Navazon skips the retry and immediately falls back to verified HQ cache instead of holding the queue.
- Album retries use the direct-by-title path rather than the slower primary Artist → Albums route.
- Search-result albums now preserve their live HQ bulk button and source-state token, allowing Download All to reuse the page that is already open instead of reopening the album.
- Adds a regression ensuring interactive album bulk honors caller-provided short timeouts.


## Cleaner User-Facing Status v1.5.6

- Removes internal source/cache terminology from user-visible bulk-download failure messages.
- If verified HQ cache completes a failed source request, no warning is shown at all.
- Partial bulk fallback now reports only how many songs could not be received; complete failure uses a short retry message.
- Track info label `محبوبیت` is renamed to `بازدید حدودی`.
- Track info label `کیفیت‌های آماده` is renamed to `کیفیت‌های موجود`.


## Artist Lists & Album Recovery v1.5.7

- Artist pages always show both `پربازدیدترین آثار` and `جدیدترین آثار`.
- Missing artist lists are loaded lazily: first from the deep catalog, then from a bounded live MeloBot resolver.
- Top and recent lists are kept semantically separate; recent tracks are no longer reused as a fake top list.
- Artist sync no longer erases a previously healthy top/recent list when the current MeloBot surface exposes only the other mode.
- Recent tracks can be recovered from MeloBot's release-date sort surface, including its native bulk controls.
- Search-result albums use a robust opener: live row -> direct artist listing -> exact album search -> collaborator component fallback.
- Collaborative album rows such as `Bahram & Ali Sorena — Khoone Khorshid` no longer depend only on the combined artist key.
- Transient Telegram Bot API network/5xx failures are retried before surfacing an update error.
- Includes the cleaner user-facing labels and bulk fallback copy from v1.5.6.


## Instant Track Pages & Catalog Repair v1.5.8

- Track pages render from local state immediately; MeloBot capability discovery is lazy and no longer blocks the initial page.
- MeloBot track pages keep HQ, normal, lyrics, cover, metadata, and Artist actions visible while unknown capabilities are resolved only when the user taps them.
- Capability failures/timeouts are treated as unknown instead of being cached as unavailable; negative lyrics state is persisted only after a confirmed source response.
- Explicit quality, lyrics, cover, metadata, Artist navigation, album navigation, search refinement, and album pagination all use bounded end-to-end source budgets.
- Primary Artist identity is never made durable while it is inferred from a title-only row; later live resolution can canonicalize the performer safely.
- Search ranking is collaboration-aware and re-ranks mixed MeloBot/Ahangify results when a complex query is only partially covered.
- Album parsing requires stronger provenance. Bare counted rows cannot become albums unless an album declaration on the same Telegram message authorizes them.
- Legacy/unverified album lists, album-track relations, and Artist-list semantics are versioned out and rebuilt from trusted source observations.
- Top and recent Artist lists have independent provenance and are derived from popularity/release-date evidence when a trusted live list is unavailable.
- Artist-page album opens use the robust bounded opener, and collaborative album fallbacks share one total budget rather than multiplying timeouts.
- Bulk HQ fallback is cooperative and time-budgeted so foreground searches/navigation regain the stateful source lane quickly.
- Background crawler work yields before starting when a foreground request arrives, reducing queue contention.
- Regression coverage includes Persian/Latin normalization, Persian/Arabic digits, collaboration syntax, inferred Artist identity, polluted album rows, cross-message keyboards, tri-state capabilities, lyrics unknown state, cache provenance migrations, and total timeout budgets.


## Composite Artist Crawl Guard v1.5.9

- Background discovery no longer opens Artist profiles for ambiguous track-level collaboration credits such as `Drake & Yeat`, `Eminem x Jay Z`, or `Sadegh feat. T-Dey`.
- Legacy queued composite-credit Artist tasks are retired before they can occupy the serialized MeloBot source lane.
- Artist identities observed directly from MeloBot's Artist picker remain source-backed and can still be crawled, including names that contain collaboration-like separators.
- The change is deliberately limited to background crawling; interactive search and Artist navigation behavior is unchanged.


## Canonical Track Identity v1.6.0

- Persian/Latin and fallback-source variants can now converge on one durable Track identity using Telegram audio metadata as high-confidence evidence.
- A new `track_aliases` table maps alternate artist/title spellings to the canonical deep-catalog Track without duplicating navigation state.
- Search results resolve known aliases before they are shown and collapse duplicates that point to the same canonical Track.
- Track pages resolve aliases locally before rendering, so an Ahangify-discovered Persian row can reuse MeloBot media, metadata and Artist navigation when the delivered audio proves they are the same song.
- Search cache namespace is bumped to `v160` so legacy split-identity results do not survive the migration.
- Positive capability snapshots expire after one hour; stale availability claims become unknown rather than remaining permanently trusted.
- A quality that fails in the current session is hidden on the refreshed Track page without turning a transient failure into a permanent negative cache.
- Artist navigation is shown only when the Track has a source-backed Artist route.
- Interactive quality waits are capped at 6.5 seconds.
- Native album/top/recent bulk work uses one bounded source attempt and no longer chains long per-track retries inside the serialized foreground queue.
- Batch media bridging is bounded, and the `clean is not defined` bulk cache crash is fixed.


## Catalog & Cache Repair v1.6.1

- Ranked MeloBot feed rows strip `#NN 🎵` before artist parsing so Top feeds no longer manufacture numbered Artist identities.
- File-cache keys ignore changing feed rank prefixes, allowing the same audio to reuse one durable cache row across feed positions.
- Multi-token searches keep full-coverage matches when available, removing partial false positives such as unrelated Reza results for `رضا بهرام یار`.
- Trustworthy legacy Artist top/recent lists self-heal their semantic version instead of forcing a slow live MeloBot round-trip.
- Track Artist navigation falls back to deep-catalog/derived popularity lists before using the live source.
- Native bulk audio metadata canonicalizes inferred Album/Artist rows, persists the repaired album relation, and immediately upgrades subsequent Track pages.
- Temporary failures for HQ/Normal/Lyrics/Cover/Artist-page actions use a 15-minute cooldown instead of reappearing on every new search or becoming permanent negatives.
- Track info is local-first and instant; missing metadata is left to background enrichment.
- Artist loading copy now says `در حال باز کردن صفحه‌ی خواننده…`.
- Production repair migrates polluted media/cache rows to clean identities and clears stale polluted metadata/tasks without discarding Telegram file IDs.
