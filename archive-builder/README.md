# Navazon Archive Builder v0.5

One-shot Radio Javan metadata harvest. No Telegram/media work and no Navazon production changes.

## Run logic

1. `prepare-snapshot.js` downloads the sitemap **once per workflow run**, filters unique `/mp3s/mp3/` URLs, hashes it, and freezes it as a workflow artifact.
2. Pilot selects 50 deterministic edge-case URLs from that frozen snapshot.
3. Full harvest splits the same frozen snapshot into 128 static shards, max 2 GitHub-hosted runners in parallel.
4. Every RJ source URL is preserved as an independent record. `canonical_match_key` is non-unique and is never used to overwrite source records.
5. Each URL has one retry budget (max 4 attempts). Systemic blocks/throttling abort a shard instead of silently hammering the source.
6. Merge reports failures, missing URLs, source-ID collisions, canonical-collision groups, and field completeness. It does not canonical-dedupe.

Baseline user-provided snapshot (2026-09-29): 32,739 unique song URLs, SHA-256 `5619481e67b0c326acb9398a4c15211d790edd67242ad63d264ae4a4fc881a41`.

## Trigger gates

On branch `archive-builder-cloud`:
- commit message containing `[archive-pilot]` → tests + frozen snapshot + 50-song pilot only.
- commit message containing `[archive-run]` → tests + frozen snapshot + full 128-shard harvest + merge.

The full run stays locked until the pilot is reviewed.
