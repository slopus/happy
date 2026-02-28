# Self-hosting (Docker Compose)

[🇨🇳 中文](self-host.zh-CN.md)

This repo supports two modes:

- **Hosted (default):** clients use `https://api.happy.hitosea.com/` out of the box.
- **Self-hosted:** run your own `happy-server` (API + WebSocket) and `happy-voice` (voice gateway) with the root `docker-compose.yml`.

This guide documents the **self-hosted** path.

## Requirements

- Docker + Docker Compose
- A LiveKit deployment (not included in `docker-compose.yml`)
  - Set `LIVEKIT_URL`, `LIVEKIT_WS_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in your `.env`
- API keys for the voice gateway (for the default providers in this repo)
  - `OPENAI_API_KEY`, `CARTESIA_API_KEY`

## Quickstart

1. Create your environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and fill required values.

At minimum for local self-host:
- `HANDY_MASTER_SECRET`
- `POSTGRES_*`
- `S3_*` (or use the MinIO defaults)
- LiveKit + voice keys (`LIVEKIT_*`, `OPENAI_API_KEY`, `CARTESIA_API_KEY`)

3. Start the stack:

```bash
docker-compose up -d
```

4. Apply database migrations (first run only):

```bash
docker-compose exec happy-server yarn --cwd packages/happy-server prisma migrate deploy
```

5. Open the web app:

- `http://localhost:3030`

Self-host uses separate origins (no path reverse proxy). Configure:
- `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3031`
- `EXPO_PUBLIC_VOICE_BASE_URL=http://localhost:3040`

## CLI: point to your self-hosted server

The CLI defaults to the hosted API. For self-host, set env vars when running:

```bash
HAPPY_SERVER_URL=http://localhost:3031 HAPPY_WEBAPP_URL=http://localhost:3030 happy
```

## Mobile app: point to your self-hosted server

- **Development builds:** set `EXPO_PUBLIC_HAPPY_SERVER_URL` when starting Expo, or use the in-app server settings screen if available.
- **Production builds:** use the in-app server settings screen to set a custom server URL.

## S3 / MinIO notes (important)

`S3_PUBLIC_URL` must be reachable by clients (browser/mobile), not just containers.

- For local Docker Compose, MinIO is exposed at `http://localhost:3050`, so `S3_PUBLIC_URL=http://localhost:3050` works.
- For remote self-hosting, you typically want a real S3-compatible endpoint and a public URL that matches your TLS/host setup.

## Remote access

If you access the web app from another device (LAN or internet), avoid hard-coded `localhost` URLs.

Recommended approach:
- Put the web app, API, and voice gateway behind domains (TLS).
- Set `EXPO_PUBLIC_HAPPY_SERVER_URL` and `EXPO_PUBLIC_VOICE_BASE_URL` to those public origins.
- Set `APP_URL` to your web origin (used by some connect flows).

## Troubleshooting

- Check containers: `docker-compose ps`
- Tail logs:
  - `docker-compose logs -f happy-server`
  - `docker-compose logs -f happy-voice`
- Verify ports on the host:
  - Web: `3030`
  - API: `3031`
  - Voice: `3040`
  - MinIO: `3050`
