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
   ignores it. Sessions the TS server deletes leave their pages behind (see
   "History offload").
5. **History.** The TS server reads only Postgres. If `HISTORY_OFFLOAD=retain`
   ever ran, old history lives only in object storage, so put it back before
   the switch:
   - Restart the Rust server with `HISTORY_OFFLOAD=shadow`, so it stops deleting.
     Reads keep merging pages until every row is back.
   - Run `happy-server-rs rehydrate` once, for example as a one-off Job from the
     same image and secrets. It copies every offloaded page's rows back into
     `SessionMessage`, one transaction per page. It is idempotent and resumable,
     so a failed or interrupted run is simply run again. `--session <id>` does
     one session. The table needs room for every offloaded row again.
   - Go on with the rollback once it reports `done: … 0 failed`. A second run
     must report `done: 0 pages`.

   With `HISTORY_OFFLOAD=shadow` or `off` (never `retain`), every message is
   still in Postgres and there is nothing to do.

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
storage (`packages/happy-server-rs/src/history.rs`):

- `HISTORY_OFFLOAD=off` (default): no background job.
- `HISTORY_OFFLOAD=shadow`: a background job copies messages older than
  `HISTORY_DB_RETENTION` (default `3d`) into pages, while every row stays in
  Postgres. Reads are served from Postgres, and each one is also compared with
  the pages off the response path.
- `HISTORY_OFFLOAD=retain`: the same job, plus it deletes from Postgres the
  rows of verified pages older than the window. The page becomes `offloaded`.
  Reads merge Postgres with the offloaded pages on every route (v1 and v3
  `GET /messages`, and the localId duplicate checks of v3 sends and socket
  messages). Clients see the same bytes as with every row in Postgres.

Reads merge in every mode once an offloaded page exists, so switching from
`retain` back to `shadow` or `off` stops the deletion but keeps old history
readable. `happy-server-rs rehydrate` puts the rows back (see "Rolling back to
the TS server").

**Pages.** A page is the rows of one session with seq in `[startSeq, endSeq]`
(1000 rows or 4 MiB at most): zstd-compressed JSON with each row's id, seq,
localId, content (the jsonb text as Postgres prints it) and ms timestamps. Pages
of a session follow each other from seq 1 and only cover a seq prefix whose rows
are all past the window, so a page never changes. Each page is indexed in
`SessionMessagePage`:
- states: `pending` → `verified` → `offloaded`, or `bad`;
- its localIds go to `SessionMessageLocalId`, so a duplicate send of a deleted
  row is still recognised. The v3 duplicate is answered with the original
  message, and the socket duplicate still burns a seq.

Both tables come from the Prisma migration
`20261112000000_add_session_message_pages` (plus
`20261112000001_session_message_page_offloaded_at` for retain). They have no
foreign keys, so
deleting a session is never blocked. The Rust server deletes a deleted
session's objects and rows after the delete commits.

**Object keys.** The format is
`history/<prefix>/<startSeq>-<endSeq>.json.zst`, in `HISTORY_S3_BUCKET`
(default `S3_BUCKET`; `DATA_DIR/history` without S3).
- `<prefix>` is the hex HMAC-SHA256 of the session id. Its key is derived from
  `HANDY_MASTER_SECRET` with the label `happy history object key`, the same way
  the auth keys are derived (PBKDF2-SHA512).
- Session ids are not secret, since they appear in URLs and logs; the prefix
  cannot be computed without the master secret.
- `SessionMessagePage.objectKey` is the key of record for reads and deletes. The
  derivation only names new pages and the prefix listed when a session is
  deleted.
- Rotating `HANDY_MASTER_SECRET` changes the prefix of new pages only. Old pages
  stay reachable through their stored keys.
- Keys are never sent to clients or logged; logs name the session and seq
  range.

History in the bucket is safe for three reasons:
- message content is encrypted on the client;
- object names carry the secret-keyed prefix;
- anonymous listing stays disabled on the bucket (`?list-type=2` on
  `files.cluster-fluster.com/happy/` returns 403).

Re-enabling anonymous ListBucket would expose every history object name.

**The job.** It runs inside the server process, one pass at a time:
- **Session scan:** each pass pages through sessions by id, 100 at a time, with
  `HISTORY_SCAN_PAUSE` (`200ms`) between chunks, then rests for
  `HISTORY_OFFLOAD_INTERVAL` (`5m`).
- **Writing a page:** insert the `pending` row, PUT the object, GET it back and
  compare it with the rows, then mark it `verified` and record its localIds in
  one transaction.
- **Retain:** before deleting, the object is compared with the rows again. The
  deletion transaction then re-checks the page (still verified, old enough, no
  bad page in the session), deletes its rows (one page, at most 1000 rows) and
  marks it `offloaded`.
- **Bad pages:** a mismatch marks the page `bad`. That stops the session's
  offload and deletion, and the log names the session and seq range.
- **Crashes:** the next pass finishes or rebuilds `pending` pages under their
  stored key. A deletion is all or nothing.
- **Verifier:** a sampled re-check (`HISTORY_VERIFY_SAMPLE` 20 pages every
  `HISTORY_VERIFY_INTERVAL` 10 m) compares verified pages with Postgres and
  checks offloaded objects.
- **Throttles:** `HISTORY_OFFLOAD_ROWS_PER_SEC` (500) and
  `HISTORY_RETAIN_ROWS_PER_SEC` (500), across `HISTORY_OFFLOAD_CONCURRENCY` (1)
  sessions at a time.
- **Settle time:** rows younger than `HISTORY_OFFLOAD_SETTLE` (`1m`) are never
  paged, whatever the retention.
- **Kill switch:** `HISTORY_OFFLOAD=off` takes effect at the next start. The
  mode is read from the environment, and changing a Deployment's environment
  restarts the pod anyway. Old history stays readable (see above).

**Metrics** (all Rust-only):
- `history_offload_backlog_rows`: old rows not yet paged. It is per session
  and updated as each pass reaches the session, so during the first pass it
  counts only the sessions seen so far. Old rows behind a younger row in the
  same session are not counted until that row ages.
- `history_pages_total{state=written|verified|offloaded|bad}`,
  `history_offloaded_bytes_total`, `history_rows_deleted_total`.
- `history_sessions_blocked`: sessions with a bad page. Alert when it is above 0.
- `history_shadow_reads_total{result=ok|mismatch|error}`: reads compared with
  verified pages.
- `history_verifier_checks_total{result=ok|mismatch}`.
- `history_storage_errors_total{op=get|put|delete}`.

Any `bad` page, shadow `mismatch` or verifier `mismatch` is a bug. Shadow
`error` means a page could not be read (see the storage errors). In retain mode
a page that cannot be read fails the read that needs it with a 500.

**Rollout plan** (not executed):
1. **Shadow.** Deploy with `HISTORY_OFFLOAD=shadow`; the deploy runs the
   migration first.
   - For the first backfill, start with the defaults (500 rows/s, one session
     at a time: about 43M rows a day). If Postgres CPU and I/O stay
     comfortable, raise `HISTORY_OFFLOAD_ROWS_PER_SEC` to 2000 and
     `HISTORY_OFFLOAD_CONCURRENCY` to 2. Lower them if not. Each change
     restarts the pod.
   - Watch for some days:
     - the backlog drains to about 0;
     - `history_sessions_blocked`, shadow mismatches and verifier mismatches
       stay at 0;
     - storage errors are rare.
   - Spot-check with `SELECT "state", count(*), sum("count"), sum("bytes") FROM
     "SessionMessagePage" GROUP BY 1`.
2. **Retain.** Switch to `HISTORY_OFFLOAD=retain`. Deletion runs at
   `HISTORY_RETAIN_ROWS_PER_SEC` (500), one page per transaction. Watch
   `history_rows_deleted_total`, read latency on `/v3/sessions/:id/messages`
   and the shadow metrics. To stop deleting, switch back to `shadow`.
3. **Database size.** Watch `pg_total_relation_size('"SessionMessage"')`.
   Deleted rows free space for reuse after autovacuum, but the table file does
   not shrink by itself. Reclaiming the disk needs `pg_repack` or `VACUUM FULL`
   (which locks the table).

**Cleanup.** After a rollback to the TS server, sessions it deletes keep their
pages. The Rust server's verifier removes such pages when it samples them. In
`shadow` mode every page can be dropped at any time: delete the `history/`
prefix of the bucket, then `TRUNCATE "SessionMessagePage",
"SessionMessageLocalId"`. Never do this after `retain` without running
`rehydrate` first.

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
