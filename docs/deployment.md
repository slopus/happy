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
4. **Migrations.** Nothing to undo. The Rust server never runs migrations in
   production (`prisma migrate deploy` stays with the TS tooling). Its only
   schema, the history offload tables below, is additive and the TS server
   ignores it. With `HISTORY_OFFLOAD=shadow` every message is still in
   Postgres, so a rollback loses nothing; sessions the TS server deletes leave
   their pages behind (see "History offload").

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

## History offload

The Rust server can move old session messages out of Postgres into object
storage (`packages/happy-server-rs/src/history.rs`). It is built in two stages,
and only the first exists so far:

- `HISTORY_OFFLOAD=off` (default): nothing happens.
- `HISTORY_OFFLOAD=shadow` (stage A): a background job copies messages older
  than `HISTORY_DB_RETENTION` (default `3d`) into pages, while every row stays
  in Postgres. Clients are still served from Postgres. Each history read is also
  compared with the pages, off the response path.
- `HISTORY_OFFLOAD=retain` (stage B, not built yet; the server refuses to start
  with it): Postgres keeps only the retention window, older history lives only
  in pages, and reads merge the two.

**Pages.** A page is the rows of one session with seq in `[startSeq, endSeq]`
(1000 rows or 4 MiB at most): zstd-compressed JSON with each row's id, seq,
localId, content (the jsonb text as Postgres prints it) and ms timestamps.
Object key `history/<sessionId>/<startSeq>-<endSeq>.json.zst`, in
`HISTORY_S3_BUCKET` (default `S3_BUCKET`). Pages of a session follow each other
from seq 1 and only cover a seq prefix whose rows are all past the window, so a
page never changes. Each page is indexed in `SessionMessagePage`
(`pending` → `verified`, or `bad`), and its localIds go to
`SessionMessageLocalId` (for stage B's duplicate check). Both tables come from
the Prisma migration `20261112000000_add_session_message_pages`. They have no
foreign keys, so deleting a session is never blocked. The Rust server deletes a
deleted session's objects and rows after the delete commits.

**Writing.** One pass over all sessions, then `HISTORY_OFFLOAD_INTERVAL`
(default `5m`) of rest. For each page: insert the `pending` row, PUT the object,
GET it back and compare it with the rows, then `verified` plus its localIds in
one transaction. A mismatch marks the page `bad`, which stops that session (and
logs the session and seq range). After a crash, the next pass finishes or
rebuilds `pending` pages. The job is throttled to
`HISTORY_OFFLOAD_ROWS_PER_SEC` (2000) across `HISTORY_OFFLOAD_CONCURRENCY` (2)
sessions at a time. Rows younger than `HISTORY_OFFLOAD_SETTLE` (`1m`) are never
paged, whatever the retention. A sampled re-check (`HISTORY_VERIFY_SAMPLE` 20
pages every `HISTORY_VERIFY_INTERVAL` 10 m) compares verified pages with
Postgres again.

**Metrics** (all Rust-only):
- `history_offload_backlog_rows`: old rows not yet paged (per session, updated
  as the pass reaches it, so during the first pass it covers only the sessions
  seen so far).
- `history_pages_total{state=written|verified|bad}` and
  `history_offloaded_bytes_total`.
- `history_shadow_reads_total{result=ok|mismatch|error}`: reads compared with
  pages.
- `history_verifier_checks_total{result=ok|mismatch}`.
- `history_storage_errors_total{op=get|put|delete}`.

Any `bad` page, shadow `mismatch` or verifier `mismatch` is a bug; the matching
log line names the session and seq. Shadow `error` means a page could not be
read (see the storage errors).

**Bucket.** The production `S3_BUCKET` serves avatars and attachments to the
public through `S3_PUBLIC_URL`. Message content is end-to-end encrypted, but
history pages should not be world-readable: set `HISTORY_S3_BUCKET` to a
private bucket that the same credentials can write.

**Rollout plan** (not executed):
1. **Shadow.** Deploy with `HISTORY_OFFLOAD=shadow` and `HISTORY_S3_BUCKET`
   set. The deploy runs the migration first. Watch for some days:
   - the backlog drains to about 0;
   - `bad` pages, shadow mismatches and verifier mismatches stay at 0;
   - storage errors are rare;
   - Postgres load during the first pass is acceptable (lower
     `HISTORY_OFFLOAD_ROWS_PER_SEC` if not).
   - Spot-check: `SELECT "state", count(*), sum("count"), sum("bytes") FROM
     "SessionMessagePage" GROUP BY 1`.
2. **Retain** (after stage B ships). Switch to `HISTORY_OFFLOAD=retain`. Rows
   of verified pages older than the window are deleted in small throttled
   batches.
3. **Database size.** Watch `pg_total_relation_size('"SessionMessage"')`.
   Deleted rows free space for reuse after autovacuum, but the table file does
   not shrink by itself. Reclaiming the disk needs `pg_repack` or `VACUUM FULL`
   (which locks the table).

**Turning it off.** `HISTORY_OFFLOAD=off` stops the job; pages and index rows
stay. In shadow mode they can be dropped at any time: delete the
`history/` prefix of the bucket and `TRUNCATE "SessionMessagePage",
"SessionMessageLocalId"`. After a rollback to the TS server, sessions it
deletes keep their pages. The Rust server's verifier removes such pages when
it samples them; the cleanup above removes them all.

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
