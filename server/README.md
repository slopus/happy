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
- 🤝 **Session Sharing** - Collaborate on conversations with granular access control
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

### Session Sharing

Happy Server supports secure collaboration through two sharing methods:

**Direct Sharing**: Share sessions with specific users by username, with three access levels:
- **View**: Read-only access to messages
- **Edit**: Can send messages but cannot manage sharing
- **Admin**: Full access including sharing management

**Public Links**: Generate shareable URLs for broader access:
- Always read-only for security
- Optional expiration dates and usage limits
- Consent-based access logging (IP/UA only logged with explicit consent)

All sharing maintains end-to-end encryption - encrypted data keys are distributed to authorized users, and the server never sees unencrypted content.

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

For local development, `yarn dev:light` is the easiest entrypoint for the light flavor (it creates the local dirs and runs `prisma migrate deploy` for the SQLite database before starting).

### Local development

#### Prerequisites

- Node.js + Yarn
- Docker (required only for the full flavor local deps)

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

# Start the server (loads `.env.dev`)
PORT=3005 yarn dev
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

Notes:

- If port `3005` is already in use, choose another: `PORT=3007 ...`.
- `yarn dev` does **not** kill anything by default. You can force-kills whatever is listening on the port by using: `PORT=3005 yarn dev -- --kill-port` (or `yarn dev:kill-port`).
- `yarn start` is production-style (it expects env vars already set in your environment).
- Minio cleanup: `yarn s3:down`.

#### Light flavor (SQLite + local files)

*The light flavor does not require Docker.* It uses a local SQLite database file and serves public files from disk under `GET /files/*`.

```bash
yarn install

# Runs `prisma migrate deploy` for SQLite before starting
PORT=3005 yarn dev:light
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

Notes:

- `yarn dev:light` runs `prisma migrate deploy` against the SQLite database (using the checked-in migration history under `prisma/sqlite/migrations/*`).
- If you are upgrading an existing light DB that was created before SQLite migrations existed, run `yarn migrate:light:resolve-baseline` once (after making a backup).
- If you want a clean slate for local dev/testing, delete the light data dir (default: `~/.happy/server-light`) or point the light flavor at a fresh dir via `HAPPY_SERVER_LIGHT_DATA_DIR=/tmp/happy-server-light`.

### Prisma schema (full vs light)

- `prisma/schema.prisma` is the **source of truth** (the full flavor uses it directly).
- `prisma/sqlite/schema.prisma` is **auto-generated** from `schema.prisma` (do not edit).
- Regenerate with `yarn schema:sync` (or verify with `yarn schema:sync:check`).

Migrations directories are flavor-specific:

- **full (Postgres)** migrations: `prisma/migrations/*`
- **light (SQLite)** migrations: `prisma/sqlite/migrations/*`

Practical safety notes for the light flavor:

- The light flavor uses Prisma Migrate (`migrate deploy`) to apply a deterministic, reviewable migration history.
- Avoid destructive migrations for user data. Prefer an expand/contract approach (add + backfill + switch code) over drops.
- Treat renames as potentially dangerous: if you only want to rename the Prisma Client API, prefer `@map` / `@@map` instead of renaming the underlying DB objects.
- Review generated SQL carefully for the light flavor. SQLite has limited `ALTER TABLE` support, so some changes are implemented via table redefinition (create new table → copy data → drop old table).
- Before upgrading a long-lived self-hosted light instance, back up the SQLite file (copy `~/.happy/server-light/happy-server-light.sqlite`) so you can roll back if needed.

The full (Postgres) flavor uses migrations:

- Dev migrations: `yarn migrate` / `yarn migrate:reset` (uses `.env.dev`)
  - Applies/creates migrations under `prisma/migrations/*`

The light (SQLite) flavor uses migrations as well:

- Apply checked-in migrations (recommended for self-hosting upgrades): `yarn migrate:light:deploy`
  - Applies migrations under `prisma/sqlite/migrations/*`
- Create a new SQLite migration from schema changes (writes to `prisma/sqlite/migrations/*`): `yarn migrate:light:new -- --name <name>`
  - Uses an isolated temp SQLite file so it never touches a user's real light database.
  - For non-trivial changes (renames, type changes, making a column required, adding uniques), you may need to edit the generated `migration.sql` or use an expand/contract sequence instead of a single-step migration.
- If you are upgrading an existing light database that was created before SQLite migrations existed, run the one-time baselining command (after making a backup): `yarn migrate:light:resolve-baseline`
- `yarn db:push:light` is for fast local prototyping only. Prefer migrations for anything you want users to upgrade without surprises.

### Schema changes (developer workflow)

When you change the data model, you must update both migration histories:

1. Edit `prisma/schema.prisma`
2. Regenerate the SQLite schema and commit the result:
   - `yarn schema:sync`
3. Create/update the **full (Postgres)** migration:
   - `yarn migrate --name <name>` (writes to `prisma/migrations/*`)
4. Create/update the **light (SQLite)** migration:
   - `yarn migrate:light:new -- --name <name>` (writes to `prisma/sqlite/migrations/*`)
5. Validate:
   - `yarn test`
   - Smoke test both flavors (`yarn dev` and `yarn dev:light`)

No-data-loss guidelines:

- Prefer “expand/contract”: add new columns/tables, backfill, switch code, and only remove old fields in a major version (or never).
- Be careful with renames. If you only need to rename the Prisma Client API, prefer `@map` / `@@map`.

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

## License

MIT - Use it, modify it, deploy it anywhere.
