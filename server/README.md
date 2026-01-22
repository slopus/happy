# Happy Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Hosting

**You don't need to self-host!** Our free cloud Happy Server at `happy-api.slopus.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Happy Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own.

## Server flavors

Happy Server supports two flavors that share the same API + internal logic. The only difference is which infrastructure backends are used for storage.

- **full** (default, recommended for production): Postgres + Redis + S3/Minio-compatible public file storage.
- **light** (recommended for self-hosting/testing): SQLite + local public file storage served by the server under `GET /files/*`.

### Choosing a flavor

- **full**: run `yarn start` (uses `sources/main.ts` → `startServer('full')`)
- **light**: run `yarn start:light` (uses `sources/main.light.ts` → `startServer('light')`)

For local development, `yarn dev:light` is the easiest entrypoint for the light flavor (it creates the local dirs and runs `prisma db push` for the SQLite database file before starting).

### Local development

#### Prerequisites

- Node.js + Yarn
- Docker (required for the full flavor dependencies: Postgres, Redis, Minio)

#### Full flavor (Postgres + Redis + S3/Minio)

This repo includes convenience scripts to start Postgres/Redis/Minio via Docker and then run migrations.

```bash
yarn install

# Start dependencies
yarn db
yarn redis
yarn s3
yarn s3:init

# Apply migrations (uses `.env.dev`)
yarn migrate

# Start the server (recommended dev start; loads `.env.dev`)
PORT=3005 yarn -s tsx --env-file=.env.dev ./sources/main.ts
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

Notes:

- If port `3005` is already in use, choose another: `PORT=3007 ...`.
- `yarn start` is production-style (it expects env vars already set in your environment).
- `yarn dev` exists but kills **anything** listening on port `3005` (`lsof ... | xargs kill -9`). Prefer the `tsx --env-file=.env.dev ...` command above.
- Minio cleanup: `yarn s3:down`.

#### Light flavor (SQLite + local files)

The light flavor does not require Docker. It uses a local SQLite database file and serves public files from disk under `GET /files/*`.

```bash
yarn install

# Runs `prisma db push` for SQLite before starting
PORT=3005 yarn dev:light
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

### Prisma schema (full vs light)

- `prisma/schema.prisma` is the **source of truth** (the full flavor uses it directly).
- `prisma/schema.sqlite.prisma` is **auto-generated** from `schema.prisma` (do not edit).
- Regenerate with `yarn schema:sqlite` (or verify with `yarn schema:sqlite:check`).

SQLite uses `prisma db push` (schema sync) instead of migrations:

- Create/update the SQLite DB schema: `yarn db:push:light`
- The `yarn dev:light` script also runs `prisma db push` automatically.

The full (Postgres) flavor uses migrations as usual:

- Dev migrations: `yarn migrate` / `yarn migrate:reset` (uses `.env.dev`)

Light defaults (when env vars are missing):

- data dir: `~/.happy/server-light`
- sqlite db: `~/.happy/server-light/happy-server-light.sqlite`
- public files: `~/.happy/server-light/files/*`
- `HANDY_MASTER_SECRET` is generated (once) and persisted to `~/.happy/server-light/handy-master-secret.txt`

### Serve UI (optional, any flavor)

You can serve a prebuilt web UI bundle (static directory) from the server process. This is opt-in and does not affect the full flavor unless enabled.

- `HAPPY_SERVER_UI_DIR=/absolute/path/to/ui-build`
- `HAPPY_SERVER_UI_PREFIX=/` (default) or `/ui`

Notes:

- If `HAPPY_SERVER_UI_PREFIX=/`, the server serves the UI at `/` and uses an SPA fallback for unknown `GET` routes (it does **not** fallback for API paths like `/v1/*` or `/files/*`).
- If `HAPPY_SERVER_UI_PREFIX=/ui`, the UI is served under `/ui` and the server keeps its default `/` route.

Legacy env vars (still supported):

- `HAPPY_SERVER_LIGHT_UI_DIR=/absolute/path/to/ui-build`
- `HAPPY_SERVER_LIGHT_UI_PREFIX=/` (default)

## License

MIT - Use it, modify it, deploy it anywhere.
