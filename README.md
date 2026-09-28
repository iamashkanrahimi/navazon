# Navazon Cloud v1

Cloud-ready Navazon Telegram music bot.

## Architecture

- Render Free Web Service: Telegram webhook + serialized source worker
- Neon Postgres: persistent catalog, Telegram file_id cache, follows, sessions, crawler metrics
- Telegram MTProto proxy account: MeloBot Premium first, Ahangify fallback
- External cron: calls `/crawler` every 2 minutes

Audio bytes are not stored in Render or Neon. Navazon stores Telegram `file_id` values and metadata.

## Render

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Required environment variables are documented in `.env.example`.

## Endpoints

- `GET /health`
- `POST /telegram/webhook`
- `GET|POST /crawler` — Bearer `CRAWLER_TOKEN`
- `GET /admin/stats` — Bearer `ADMIN_TOKEN`

On Render, the app uses `RENDER_EXTERNAL_URL` and configures the Telegram webhook at startup.

## Crawler

Crawler is metadata-first and runs only when the source queue is idle and the user has been inactive for at least 2 minutes. It expands the catalog through search results, top tracks, albums, album tracklists, featured artists, Ahangify supplemental metadata, and MeloBot-home bootstrap discovery.

Automatic audio warming remains disabled by default with `DISCOVERY_WARM_TOP_TRACKS=0`.
