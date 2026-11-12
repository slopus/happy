# Deployment

This document describes how to deploy the Happy backend (`packages/happy-server`) and the infrastructure it expects.

## Runtime overview
- **App server:** Node.js running `tsx ./sources/main.ts` (Fastify + Socket.IO).
- **Database:** Postgres via Prisma.
- **Cache:** Redis (currently used for connectivity and future expansion).
- **Object storage:** S3-compatible storage for user-uploaded assets (MinIO works).
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

## Required services
1. **Postgres**
   - Required for all persisted data.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Required by startup (`redis.ping()` is called).
   - Configure via `REDIS_URL`.
   - Managed by this repo: `packages/happy-server/deploy/happy-redis.yaml` (StatefulSet + redis-exporter sidecar).

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.
   - **Deployed separately** — not managed by this repo's Kubernetes manifests. In prod, the S3-compatible service (MinIO or similar) behind `S3_PUBLIC_URL` is provisioned and managed by external infrastructure. The app only consumes it via env vars: `S3_PUBLIC_URL` is set in the Deployment, and credentials come from Vault via ExternalSecret (`/handy-files`).
   - If `S3_HOST` is unset, the server falls back to local filesystem storage (`./data/files/`).
   - For local k8s dev, a MinIO pod is deployed via `deploy/overlays/local/minio.yaml`.

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
- Subscriptions: none. The server no longer checks subscriptions (the phones track them with RevenueCat), so `REVENUECAT_API_KEY` is unused and can be removed from deployments.
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Docker image
A production Dockerfile is provided at `Dockerfile.server`. It runs the Rust port
of the server (`packages/happy-server-rs`), which is wire-compatible with
`packages/happy-server` and uses the same Prisma schema.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image keeps the Prisma CLI, so migrations still run with `prisma migrate deploy`
  from `/repo/packages/happy-server`.
- The Rust server is one process per database: no Redis adapter, and a Postgres
  advisory lock keeps a second instance from starting. Run one replica, and deploy
  by stopping the old pod before starting the new one (`strategy: Recreate`).
- `HAPPY_WORKERS` sets the worker threads (default: the CPUs the container may use).

## Kubernetes manifests
Example manifests live in `packages/happy-server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.

## Production deployment order

The `Lab_HappyServer` TeamCity build runs Build, Push, and its private Deploy
recipe in order. The recipe runs `prisma migrate deploy` in a one-off
Kubernetes Job using the new image and `handy-secrets`, then applies
`handy.yaml` and waits for the rollout. A failed migration exits before apply.

GitHub CI continues to apply migrations to its disposable Postgres database.
Production migrations run before the rolling update, so they must remain
compatible with the currently running release; destructive changes require an
expand/contract deployment.

## Rolling back to the TS server

Production switched to the Rust server in `922bde535` ("Run the Rust server in
production"). Every commit before it, up to `88aefd73f`, builds the TS image
from `Dockerfile.server`.

1. **Image.** Redeploy the last `docker.korshakov.com/handy-server` tag that
   TeamCity built before `922bde535`, or run `Lab_HappyServer` on `88aefd73f`.
   On `main`, `git revert 922bde535` restores both `Dockerfile.server` and
   `handy.yaml` in one commit.
2. **Manifest.** The TS settings in `handy.yaml`, as before `922bde535`:
   - `replicas: 3`
   - `strategy: RollingUpdate` with `maxUnavailable: 0`, `maxSurge: 2`
   - `REDIS_URL=redis://happy-redis:6379` back in `env`; remove `HAPPY_WORKERS`
   - readiness probe `initialDelaySeconds: 30`, `periodSeconds: 60`, `timeoutSeconds: 30`
   - PodDisruptionBudget `minAvailable: 1` (instead of `maxUnavailable: 1`)

   The `happy-redis` StatefulSet stays deployed under the Rust server, so the
   TS adapter finds it.
3. **Order.** The rollback rollout uses the new strategy (RollingUpdate), so the
   Rust pod and the new TS pods would serve side by side for a while. Writes stay
   correct (every seq is an atomic `UPDATE … RETURNING`), but sockets on the Rust
   pod cannot reach RPC targets or rooms on the TS pods, and the reverse. Stop the
   Rust pod first:
   `kubectl scale deployment/handy-server --replicas=0`, then apply the TS
   manifest. The Rust server's advisory lock is per session, so it is released
   when the pod exits; the TS server never takes it.
4. **Migrations.** Nothing to undo. The Rust server adds no schema and never runs
   migrations in production (`prisma migrate deploy` stays with the TS tooling).

Data written by the Rust server is valid for the TS server:
- **`Session.updatedAt` / `Account.updatedAt`.** Group commit bumps them once per
  batch instead of once per message. The value is the batch's write time, at or
  after every message in it, and it still increases. So `/v1/sessions` (ordered
  by `updatedAt`) sorts the same, and `/v2/sessions?changedSince=` still reports
  the session as changed.
- **User and session seqs.** Batches take consecutive ranges from the same
  `Account.seq` and `Session.seq` counters with one atomic `UPDATE`, so nothing
  is skipped or reused. The TS server continues from the stored values, and
  clients see no gap or repeat.
- **Message rows** have the TS shape: client-side millisecond `createdAt` and
  `updatedAt`, cuid ids, `{"t":"encrypted","c":…}` jsonb content.
- **Other differences** are not stored state (see
  `packages/happy-server-rs/QUIRKS.md`, "Known deviations"). One exception:
  avatar thumbhashes computed by the Rust server can differ slightly for
  resized images (deviation 15). They stay valid.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `pnpm --filter happy-server db` (Postgres in Docker)
- `pnpm --filter happy-server redis`
- `pnpm --filter happy-server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `pnpm --filter happy-server dev`.

## Implementation references
- Entrypoint: `packages/happy-server/sources/main.ts`
- Dockerfile: `Dockerfile.server`
- Kubernetes manifests: `packages/happy-server/deploy`
- Env usage: `packages/happy-server/sources` (`rg -n "process.env"`)
