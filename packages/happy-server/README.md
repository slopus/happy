# Paws Self-Host Server

Self-hostable synchronization backend for Paws clients and supported AI coding agents.

## What It Does

The server is the synchronization backbone for Paws. It lets multiple clients exchange encrypted session records while keeping plaintext conversations on paired clients and the selected agent/provider path. Internal package names still use `happy-server-self-host` for compatibility.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Deliver attention and completion signals through the configured push provider
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Paws clients generate and hold encryption keys locally and use the server as a relay. Session payloads are encrypted before synchronization. The server stores and routes records, machine/session presence, and delivery metadata needed for realtime operation.

## Hosting

Paws can use the service configured in the App and CLI, or this package can run on infrastructure you control. Self-hosters are responsible for TLS, access control, backups, logs, retention, object-storage policy, monitoring, and upgrades. Review the root privacy policy before operating a service for other users.

## Self-Hosting with Docker

The standalone Docker image runs everything in a single container with no external dependencies (no Postgres, no Redis, no S3).

```bash
docker build -t paws-server -f Dockerfile .
```

Run from the monorepo root:

```bash
docker run -p 3005:3005 \
  -e HANDY_MASTER_SECRET=<your-secret> \
  -v paws-data:/data \
  paws-server
```

This uses:
- **PGlite** - embedded PostgreSQL (data stored in `/data/pglite`)
- **Local filesystem** - for file uploads (stored in `/data/files`)
- **In-memory event bus** - no Redis needed

Data persists in the `paws-data` Docker volume across container restarts.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Master secret for auth/encryption |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `DATA_DIR` | No | `/data` | Base data directory |
| `PGLITE_DIR` | No | `/data/pglite` | PGlite database directory |

### Optional: External Services

To use external Postgres or Redis instead of the embedded defaults, set:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL (bypasses PGlite) |
| `REDIS_URL` | Redis connection URL |
| `S3_HOST` | S3/MinIO host |
| `S3_PORT` | S3/MinIO port |
| `S3_USE_SSL` | Whether the S3 endpoint uses TLS (`true` or `false`) |
| `S3_ACCESS_KEY` | S3 access key (secret) |
| `S3_SECRET_KEY` | S3 secret key (secret) |
| `S3_BUCKET` | S3 bucket name |
| `S3_PUBLIC_URL` | Optional public base URL for non-share objects |
| `PEXELS_API_KEY` | Server-only Pexels API key for random/imported share covers |
| `PUBLIC_SHARE_LOCAL_STORAGE` | Set to `enabled` only to explicitly allow local public-share storage in a production self-host deployment |

Hosted production public shares fail closed unless `S3_HOST`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, and `S3_BUCKET` are all configured. A production self-host may
explicitly opt into filesystem storage with `PUBLIC_SHARE_LOCAL_STORAGE=enabled`;
development and test environments continue to use local storage. Never expose
`PEXELS_API_KEY`, S3 credentials, or the server environment to the app/browser.

### S3 bucket configuration (when self-hosting with S3)

When `S3_HOST` is set, image attachments and other blobs land in S3 under
`sessions/<sessionId>/attachments/<id>.enc`. Two bucket-level settings are
not configured by the server itself and must be applied once at deploy
time:

**1. Lifecycle rule for attachment TTL.** Encrypted blobs are deleted when
their session is deleted, but a long-lived session would otherwise keep
its blobs forever. Add a lifecycle rule on the attachments prefix so
objects age out automatically. Pick a TTL that matches your retention
policy (30 days is a reasonable default).

```bash
# AWS CLI
aws s3api put-bucket-lifecycle-configuration --bucket happy-blobs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "session-attachments-ttl",
      "Status": "Enabled",
      "Filter": { "Prefix": "sessions/" },
      "Expiration": { "Days": 30 }
    }]
  }'

# MinIO
mc ilm rule add myminio/happy-blobs \
  --expire-days 30 \
  --prefix "sessions/"
```

**2. Server-side encryption (defense-in-depth).** Blobs are already
end-to-end encrypted by the client, but enabling AES-256 SSE on the
bucket protects against an attacker who somehow obtains raw object
storage access without the keys.

```bash
# AWS CLI
aws s3api put-bucket-encryption --bucket happy-blobs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# MinIO
mc encrypt set sse-s3 myminio/happy-blobs
```

Local-storage mode (no `S3_HOST`) writes blobs under
`<DATA_DIR>/files/sessions/<sessionId>/attachments/`. There is no
lifecycle equivalent — clean up old session directories on a cron if
you want a TTL story. Production public-share assets require the explicit
`PUBLIC_SHARE_LOCAL_STORAGE=enabled` opt-in described above.

## License

MIT - Use it, modify it, deploy it anywhere.
