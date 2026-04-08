# Deployment

This document describes how to deploy the Happy backend (`packages/happy-server`) and the infrastructure it expects.

## Runtime overview
- **App server:** Node.js running `tsx ./sources/main.ts` (Fastify + Socket.IO).
- **Database:** Postgres via Prisma.
- **Cache/Pub-Sub:** Redis — powers the cross-process backplane for real-time event delivery and distributed RPC forwarding. Optional for single-process deployments.
- **Object storage:** S3-compatible storage for user-uploaded assets (MinIO works). Required for multi-pod deployments.
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

## Deployment modes

### Single-process (standalone)
No Redis or S3 required. Uses PGlite (embedded Postgres) and local filesystem storage.
Ideal for self-hosting and development. Run via `yarn standalone:dev` or the standalone
Docker image (`Dockerfile`).

### Single-process (production)
Postgres required. Redis and S3 optional. When `REDIS_URL` is not set, the server uses
`MemoryBackplane` (in-process pub/sub). All functionality works, but only one process can
serve traffic.

### Multi-process (production)
Postgres + Redis + S3 required. When `REDIS_URL` is set, the server uses `RedisBackplane`
for cross-process event delivery and distributed RPC forwarding. Set `replicas: 2+` in
`deploy/handy.yaml`. See `docs/plans/multiprocess-architecture.md` for full architecture.

**Prerequisites for multi-pod:**
- `DATABASE_URL` — PostgreSQL (not PGlite, which is single-process only)
- `REDIS_URL` — enables cross-process event delivery and RPC
- `S3_HOST` + `S3_ACCESS_KEY` + `S3_SECRET_KEY` + `S3_BUCKET` — enables shared file storage

The server validates these prerequisites at startup and logs warnings for misconfigurations
(e.g., Redis configured but S3 not set).

## Required services
1. **Postgres**
   - Required for all persisted data.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Powers the cross-process backplane (event delivery + distributed RPC).
   - Optional for single-process deployments — the server falls back to `MemoryBackplane`.
   - Required for multi-pod deployments (`replicas: 2+`).
   - Configure via `REDIS_URL`.

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Required for multi-pod deployments (local filesystem is not shared across pods).
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.

## Environment variables
**Required**
- `DATABASE_URL`: Postgres connection string.
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.
- `REDIS_URL`: Redis connection string.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: object storage config.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).

**Optional integrations**
- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, plus redirect URL/URI.
  - `GITHUB_REDIRECT_URL` is used by the OAuth callback handler.
  - `GITHUB_REDIRECT_URI` is used by the GitHub App initializer.
- Voice: `ELEVENLABS_API_KEY` (required for `/v1/voice/conversations` in production).
- Subscriptions: `REVENUECAT_API_KEY` (server-side RevenueCat key, required for voice subscription checks).
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Docker images

### `Dockerfile` (standalone)
Self-contained single-container image with PGlite (embedded Postgres), local filesystem
storage, and no Redis dependency. Runs `standalone.ts` → `main.ts` with `MemoryBackplane`.
Suitable for self-hosting and development.

```bash
docker build -t happy-server-standalone -f Dockerfile .
docker run -p 3005:3005 -e HANDY_MASTER_SECRET=your-secret -v happy-data:/data happy-server-standalone
```

### `Dockerfile.server` (production)
Production image for Kubernetes deployment. Requires external Postgres, Redis, and S3.
Runs `yarn --cwd packages/happy-server start` → `main.ts`. When `REDIS_URL` is set, uses
`RedisBackplane` for cross-process delivery.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image includes FFmpeg and Python for media processing.
- The `/health` endpoint reports `processId` and `redis` status for operational monitoring.

## Kubernetes manifests
Example manifests live in `packages/happy-server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.
- `terminationGracePeriodSeconds: 15` for clean backplane disconnect and RPC registry cleanup.

### Scaling to multiple replicas

1. Ensure `REDIS_URL`, `S3_HOST`, and `DATABASE_URL` (Postgres) are configured.
2. Change `replicas: 1` to `replicas: 2` (or more) in `deploy/handy.yaml`.
3. Optionally enable session affinity (commented annotations in `handy.yaml`) to reduce cross-process hops.
4. Verify via `/health` endpoint — each pod reports a unique `processId` and `redis: 'ok'`.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `yarn workspace happy-server db` (Postgres in Docker)
- `yarn workspace happy-server redis`
- `yarn workspace happy-server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `yarn workspace happy-server dev`.

## Implementation references
- Entrypoint: `packages/happy-server/sources/main.ts`
- Dockerfile: `Dockerfile.server`
- Kubernetes manifests: `packages/happy-server/deploy`
- Env usage: `packages/happy-server/sources` (`rg -n "process.env"`)
