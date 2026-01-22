# Happy Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## Server flavors

This repo supports two server flavors:

- **full** (default, recommended for production): Postgres + Redis + S3/Minio-style public file storage.
- **light** (recommended for self-hosting/testing): SQLite + local file storage served from the same process under `GET /files/*`.

SQLite schema note:

- `prisma/schema.prisma` is the source of truth.
- `prisma/schema.sqlite.prisma` is auto-generated (do not edit).
- Regenerate with `yarn schema:sqlite`.

### Run (full)

```bash
yarn start
```

### Run (light)

```bash
yarn dev:light
```

Light defaults (when env vars are missing):

- data dir: `~/.happy/server-light`
- sqlite db: `~/.happy/server-light/happy-server-light.sqlite`
- public files: `~/.happy/server-light/files/*`
- `HANDY_MASTER_SECRET` is generated (once) and persisted to `~/.happy/server-light/handy-master-secret.txt`

Optional UI serving (any flavor):

- `HAPPY_SERVER_UI_DIR=/path/to/ui-build`
- `HAPPY_SERVER_UI_PREFIX=/` (default)

Legacy (still supported):

- `HAPPY_SERVER_LIGHT_UI_DIR=/path/to/ui-build`
- `HAPPY_SERVER_LIGHT_UI_PREFIX=/` (default)
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

## License

MIT - Use it, modify it, deploy it anywhere.
