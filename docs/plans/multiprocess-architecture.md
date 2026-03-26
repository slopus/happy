# Multiprocess-Safe Real-Time Delivery & Cross-Process RPC

## Overview

This document describes the architecture decisions, design rationale, and operational
guidance for running happy-server as multiple processes behind a load balancer.

## Problem Statement

The server was originally single-process-only by architecture. Two hard blockers
existed for multi-process deployment:

1. **Real-time event delivery was process-local.** The `EventRouter` stored connections
   in a local `Map<string, Set<ClientConnection>>`. Events emitted on one process never
   reached WebSocket clients connected to another process.

2. **RPC method registration was process-local.** The `rpcListeners` map in `socket.ts`
   was local to each process. Since mobile app and CLI daemon typically land on different
   pods, 100% of cross-device RPC calls would fail in a multi-pod deployment.

## Architecture Decisions

### Why Backplane + EventRouter (not Socket.IO Adapter)

The standard approach for multi-process Socket.IO is the Redis Streams adapter
(`@socket.io/redis-streams-adapter`). We explicitly chose **not** to use it because:

- The codebase uses **zero** Socket.IO rooms, **zero** broadcasts, and **zero** `io.to()`
  calls. The adapter's primary value (cross-process room delivery) would change nothing.
- The `EventRouter` singleton has a well-defined filtering model (`RecipientFilter` with
  four distinct types) that does not map cleanly to Socket.IO rooms.
- The Backplane abstraction gives us control over serialization, channel naming, and
  cross-process RPC forwarding — none of which the Socket.IO adapter provides.

**Decision:** Custom `Backplane` interface behind `EventRouter`, with `MemoryBackplane`
(dev/single-process) and `RedisBackplane` (multi-process) implementations.

### Why `init()` Pattern (not Dependency Injection)

The `eventRouter` is a module-level singleton imported by **21 files** with **32 call
sites**. Switching to constructor-based DI would require refactoring every import site.

**Decision:** The `EventRouter` class exposes an `init(backplane)` method called once
from `main.ts` before `startApi()`. If `init()` is not called, the router falls back to
legacy local-only delivery — preserving backward compatibility with existing tests and
the standalone/PGlite development mode.

### Why Per-Process Registration Sets for RPC (not Per-Field Hash TTL)

The original design proposed storing RPC registrations in a Redis hash (`HSET`) with
per-field TTL for stale entry cleanup. **This is impossible in Redis** — `EXPIRE` applies
to entire keys, not individual hash fields.

**Corrected design:**

- **Per-process registration set:** `hp:rpc:proc:{processId}` is a Redis SET containing
  `{userId}:{method}` strings. This key has a 60-second TTL, refreshed every 20 seconds
  by a heartbeat timer. If a process crashes, its key auto-expires within 60 seconds.

- **Global lookup hash:** `hp:rpc:methods:{userId}` maps `{method}` → `{processId}` for
  O(1) lookup when routing an RPC call. This key has no TTL — it's actively maintained via
  register/unregister operations.

- **Stale entry recovery:** If a call to a remote process times out after 5 seconds
  (separate from the 30-second client timeout), the caller checks `EXISTS hp:rpc:proc:
  {targetProcessId}`. If the key is gone (process crashed), the stale method entry is
  cleaned from `hp:rpc:methods:{userId}` and the caller returns `{ ok: false }`.

- **Graceful shutdown:** On `destroy()`, the process deletes its registration set and
  cleans up all its entries from the global lookup hashes.

## Redis Key Layout

| Key Pattern | Type | TTL | Purpose |
|---|---|---|---|
| `hp:user:{userId}:updates` | Pub/Sub channel | — | Cross-process persistent event delivery |
| `hp:user:{userId}:ephemeral` | Pub/Sub channel | — | Cross-process ephemeral event delivery |
| `hp:rpc:req:{processId}` | Pub/Sub channel | — | RPC request delivery to a specific process |
| `hp:rpc:res:{requestId}` | Pub/Sub channel | — | RPC response delivery for a specific request |
| `hp:rpc:proc:{processId}` | SET | 60s (refreshed every 20s) | Per-process RPC method registration set |
| `hp:rpc:methods:{userId}` | HASH | none (actively maintained) | Global RPC method → processId lookup |

The `hp:` prefix avoids collisions with other Redis users on the same instance.

## Background Workers: Multi-Process Safety

### Timeout Sweep (`timeout.ts`)

The timeout sweep runs on every process simultaneously. This is safe because:

1. **Atomic conditional update.** `updateManyAndReturn({ where: { id, active: true } })`
   ensures exactly one process succeeds per session/machine timeout. The losing process
   gets an empty result set and skips the ephemeral emit.

2. **Ephemeral events route through the backplane.** After the winning process emits
   `eventRouter.emitEphemeral()`, the event is published to the backplane channel
   `hp:user:{userId}:ephemeral`. Every process subscribed for that user delivers it to
   locally-connected user-scoped sockets.

3. **Client-side idempotency.** The mobile app's `ActivityUpdateAccumulator` deduplicates
   same-state activity updates via its `isSignificantChange` check. Setting `active: false`
   twice produces the same UI state. Machine activity updates are also idempotent — 
   `applyMachines()` is a state merge.

**Waste:** N processes × (1 `findMany` + M conditional `updateManyAndReturn`) per sweep
cycle (60 seconds). For 2-4 replicas, this is negligible. At higher scale, leader election
would reduce to 1× queries.

### Database Metrics Updater (`metrics2.ts`)

Runs on every process simultaneously. This is safe because:

1. **All queries are read-only.** Four `count()` queries, no writes.
2. **Prometheus gauges are process-local.** Each pod reports its own gauge values.
   Prometheus scrapes each pod independently — duplicate values are expected.

**Waste:** N × 4 count queries per 60 seconds. Tolerable at any reasonable replica count.

### Leader Election (Deferred)

Running duplicate background workers wastes DB queries proportional to replica count.
Two leader election approaches are available as future optimizations:

#### Option A: PostgreSQL Advisory Locks

```sql
SELECT pg_try_advisory_lock(hashtext('timeout-sweep'))
```

- **Pros:** Zero external dependencies (uses existing Postgres connection). Automatically
  released on session disconnect (process crash).
- **Cons:** Lock is session-scoped — if the DB connection drops but the process stays alive,
  the lock is released and another process takes over (may cause brief overlap).
- **Implementation:** Wrap the `forever()` loop body in a try-advisory-lock check. If the
  lock isn't acquired, sleep and retry.

#### Option B: Redis `SET NX PX`

```
SET hp:leader:timeout {processId} NX PX 90000
```

- **Pros:** Uses existing Redis connection. Explicit TTL prevents zombie locks.
- **Cons:** Requires Redis (not available in standalone/PGlite mode). Requires explicit
  renewal logic (SET NX PX + periodic refresh).
- **Implementation:** Before each sweep cycle, attempt `SET NX PX`. If acquired, run the
  sweep and refresh the TTL. If not acquired, sleep until next cycle.

**Recommendation:** Option A (advisory locks) for timeout sweep since it works in all
deployment modes. Option B is viable for the metrics updater if Redis is always available.

Neither is urgent — the current duplicate execution is correct and the overhead is
minimal at typical replica counts (2-4).

## File Storage: Multi-Pod Dependency

File storage via `storage/files.ts` uses the local filesystem when `S3_HOST` is unset.
The following files are affected in multi-pod deployments without S3:

| File | Impact |
|---|---|
| `storage/files.ts:1-7` | File read/write goes to local disk |
| `storage/uploadImage.ts:29-34` | Image uploads stored locally |
| `app/api/api.ts:59-72` | Serves local files — pod B can't serve pod A's uploads |
| `eventRouter.ts:431` | Avatar URL generation via `getPublicUrl()` |
| `app/api/routes/accountRoutes.ts:33` | Avatar URL in account profile |

**Startup validation** (Task 6) logs a warning when `REDIS_URL` is set but `S3_HOST` is
not, indicating a likely multi-pod deployment without shared file storage.

## What's Deferred

| Item | Reason |
|---|---|
| **Auth cache revocation** | `invalidateUserTokens()` has zero callers. Even if called, clearing the local map doesn't prevent re-verification. Real revocation requires a denylist or token versioning — separate initiative. |
| **Leader election** | Background workers are idempotent. Duplicate sweeps waste DB queries but produce correct results. Optimization for high replica counts. |
| **Graceful draining** | All clients use `transports: ['websocket']` with Socket.IO's built-in reconnection. Proper draining (503 readiness probe, connection handoff) is operational polish. |
| **Distributed ActivityCache** | Each process flushes only heartbeats it received directly. No double-writes. The 30-second validation TTL is acceptable staleness. |
| **Horizontal auto-scaling (HPA)** | This sprint enables manual `replicas: N`. Auto-scaling policies are infrastructure work. |

## Module Layout

The multiprocess infrastructure lives in two new module directories:

### `sources/modules/backplane/`

| File | Purpose |
|---|---|
| `backplane.ts` | `Backplane` interface, channel naming helpers, `createProcessId()` |
| `memoryBackplane.ts` | `MemoryBackplane` — in-process pub/sub via `EventEmitter`. Default when `REDIS_URL` is not set. |
| `redisBackplane.ts` | `RedisBackplane` — Redis pub/sub with dedicated publisher/subscriber connections. Exposes `getRedis()` for RPC registry commands. |
| `createBackplane.ts` | Factory function — returns `RedisBackplane` if `REDIS_URL` is set, `MemoryBackplane` otherwise. |

### `sources/modules/rpc/`

| File | Purpose |
|---|---|
| `distributedRpc.ts` | `DistributedRpcRegistry` — cross-process RPC forwarding using Redis pub/sub and per-process registration sets with heartbeat TTL. |

### `sources/modules/config/`

| File | Purpose |
|---|---|
| `startupValidation.ts` | Startup prerequisite checks — validates `HANDY_MASTER_SECRET`, warns on Redis+local-storage and PGlite+Redis misconfigurations. |

## Deployment Configuration

### Kubernetes (`deploy/handy.yaml`)

The deployment manifest includes:

- `replicas: 1` by default, with comments documenting that `replicas: 2+` is supported
  with Redis + S3.
- `terminationGracePeriodSeconds: 15` to allow clean Backplane disconnect and RPC
  registry cleanup on pod termination.
- Session affinity annotations (commented out) — optional, reduces cross-process hops
  but not required since all clients use `transports: ['websocket']`.
- `REDIS_URL` already points to `redis://happy-redis:6379`.
- Liveness/readiness probes hit `/health`, which now includes `processId` and `redis`
  status fields.

### Docker Images

**`Dockerfile` (standalone):** Runs `standalone.ts` → `import("./main")` → Backplane
init with `MemoryBackplane` (no Redis). Uses PGlite for embedded Postgres. Single
container, zero external dependencies. Suitable for self-hosting and development.

**`Dockerfile.server` (production):** Runs `yarn --cwd packages/happy-server start` →
`main.ts`. Designed for Kubernetes deployment with external Postgres, Redis, and S3.
When `REDIS_URL` is set, uses `RedisBackplane` for cross-process delivery. When `REDIS_URL`
is not set, falls back to `MemoryBackplane` (single-process mode).

### Removed Dependencies

The following unused packages were removed from `package.json`:

- `@socket.io/redis-streams-adapter` — zero imports in the codebase. The custom Backplane
  approach was chosen instead (see "Why Backplane + EventRouter" above).
- `socket.io-adapter` — zero imports. Was a transitive type dependency for the unused
  Redis streams adapter.

## Operational Guidance

### Verifying Multi-Process Mode

The `/health` endpoint includes:
- `processId`: unique identifier for the responding process
- `redis`: `'ok'` or `'error'` (only when Redis backplane is active)

```bash
# Check each pod's health
curl http://pod-a:3000/health
# → { "status": "ok", "processId": "abc-123", "redis": "ok" }

curl http://pod-b:3000/health  
# → { "status": "ok", "processId": "def-456", "redis": "ok" }
```

### Scaling Up

1. Ensure `REDIS_URL` is set and Redis is reachable.
2. Ensure `S3_HOST` (+ `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`) is set for
   shared file storage.
3. Ensure `DB_PROVIDER=postgres` (not `pglite` — PGlite is single-process only).
4. Increase `replicas` in `deploy/handy.yaml`.
5. Optional: add session affinity (`nginx.ingress.kubernetes.io/affinity: "cookie"`) to
   reduce cross-process hops, though it's not required for correctness.

### Startup Log

On boot, each process logs its backplane configuration:
```
Backplane: redis (processId: abc-123-def-456)
```
or:
```
Backplane: memory (processId: abc-123-def-456, single-process mode)
```
