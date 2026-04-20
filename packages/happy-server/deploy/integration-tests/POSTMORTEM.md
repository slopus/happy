# Multi-pod Redis adapter — postmortem

Local reproduction in minikube against the full broken stack
(`888b87a3` + `b42b9c45` + `9e9e5f4f`, restored in working tree, NOT
on origin/main).

## Setup
- 2 happy-server replicas behind a `LoadBalancer` service via `minikube tunnel`
- Single Redis (`@socket.io/redis-streams-adapter`)
- All tests use `transports: ['websocket']` (matches prod client)
- Test harnesses: `deploy/hammer.mjs`, `deploy/network-loss.mjs`,
  `deploy/test-rpc-cross-replica.mjs`, `deploy/test-multiprocess.mjs`

## What works (steady state)

| Test                    | Result      | Notes |
|-------------------------|-------------|-------|
| Cross-replica broadcast | ✅ 20/20    | Pod kill, fan-out, all 8 surviving clients undisrupted |
| Cross-pod RPC (steady)  | ✅ 50/50 ×5 | Repeated; once warm, parallel + sequential RPCs all pass |
| LB cross-pod routing    | ✅          | k8s service distributes new sockets across both pods |

The original `9e9e5f4f` claim "Tested locally: 10/10 cross-replica RPC
calls pass" is true — **in steady state**, with no churn, no kills, no
network jitter, and no waiting longer than the TTL.

## What's broken (4 reproduced bugs)

### Bug #1: in-flight RPC eats the full 30s timeout when target pod dies

**Repro:** `node deploy/hammer.mjs pod-kill-mid-rpc`

```
[+ 1.85s] firing rpc-call (will block 5s in handler)
[+ 1.89s]   daemon got rpc-request, sleeping 5s
[+ 2.85s] killing daemon pod handy-server-67b86c7b7c-2bc6f
[+ 2.94s]   socket disconnect: transport close
[+ 3.27s]   socket reconnected
[+31.85s] rpc-call result: ok=false latency=30002ms err=operation has timed out
```

- Daemon's pod is killed mid-call. Daemon socket transport-closes within 90ms.
- Daemon **reconnects in 0.4s** on a different pod.
- Caller's `rpc-call` **hangs for the full 30 seconds** then times out.

**Root cause:**
`rpcHandler.ts:159` does
`io.to(targetSocketId).timeout(30000).emitWithAck('rpc-request', ...)`.
The streams adapter broadcasts the request through Redis. No replica
has the dead `targetSocketId`. No socket replies. `emitWithAck` waits
the full timeout. There is no fast-fail path for "the target socketId
no longer exists anywhere in the cluster."

The dead Redis key is not cleaned up either — the daemon's pod was
SIGKILL'd so its disconnect handler never ran. Even on graceful
shutdown the cleanup is best-effort.

**Production manifestation:** every pod recycle, every daemon
reconnect → every concurrent web RPC eats 30s. Multiple retries from
the client compound this into multi-minute hangs. This explains the
user's "say lol after running ls 3 times took 3 minutes" report.

### Bug #2: reconnect-storm race ⇒ ~6% RPC failures

**Repro:** `node deploy/hammer.mjs reconnect-storm`

```
results: success=178 fail=12
  err: RPC method not available ×7   ← Redis key was deleted, not yet recreated
  err: RPC target not reachable ×5   ← Redis key still pointed at dead socketId
```

- Daemon reconnects 5×, callers fire RPCs at 200ms intervals throughout.
- ~150ms reconnect window per cycle = ~1 RPC-window per reconnect per caller.
- 5 cycles × 5 callers ≈ 25 vulnerable calls, 12 fail.

**Root cause:** the daemon's disconnect handler runs a Lua CAS that
deletes the Redis key. The reconnect's `rpc-register` runs a fresh
SET. Between those two events any cross-pod caller sees one of:

- key absent → `RPC method not available`
- key present pointing at the **old** socketId (not yet cleaned up
  because the daemon's disconnect handler ran on a different pod and
  raced with the new register) → `RPC target not reachable`

There is no atomic "swap" semantic. The design fundamentally cannot
maintain RPC availability across a daemon socket transition.

**Production manifestation:** the prod web client logs showed 🔌
"Socket reconnected" followed by repeated `fetchMessages → 0 messages`
churn. Every reconnect = a small but real burst of RPC failures, which
cascade into the sync layer's invalidate loop.

### Bug #3 (smoking gun): silent TTL expiry while daemon is connected

**Repro:** `node deploy/hammer.mjs ttl-expiry`, OR
`node deploy/network-loss.mjs` — both reproduce this at the +60s mark
without any network manipulation.

```
[+   5.19s] t=+5s  rpc: ok=true
[+  30.25s] t=+30s rpc: ok=true
[+  55.35s] t=+55s rpc: ok=true
[+  65.35s] t=+65s rpc: ok=false err=RPC method not available
[+  75.36s] t=+75s rpc: ok=false err=RPC method not available
```

- Daemon **stays connected** the whole time.
- After exactly 60 seconds the Redis key expires (`RPC_TTL_SECONDS = 60`,
  `rpcHandler.ts:6`).
- The daemon never knows. No code path on the daemon side detects the
  expiration and re-registers. **The state stays broken until the
  daemon reconnects** (which it might not do for hours).

**Root cause:** TTL refresh only happens inside `machine-alive` and
`session-alive` handlers (`machineUpdateHandler.ts:53`,
`sessionUpdateHandler.ts:185`). If for **any reason** the daemon
doesn't fire a keep-alive event in the 60-second window — slow
network, blocked event loop on either side, dropped UDP, paused
process, GC pause, anything — the registration vaporizes silently.

There is no:
- monitoring on the server to detect expired-but-still-connected
  sockets
- monitoring on the daemon to detect "my registration is gone"
- background re-registration timer on the daemon

**Production manifestation:** explains the cases where RPCs fail with
"method not available" even though the daemon is "online" in the UI.
Once it happens, it stays broken.

### Bug #4: streams adapter unbounded-ish growth

**Observation:** `kubectl exec happy-redis-0 -- redis-cli XINFO STREAM socket.io`

```
length            4946
groups            0
recorded-first-entry-id  1775994568700-0  (~70 minutes ago)
last-generated-id        1775998585928-0  (now)
entries-added            4946
```

- The `socket.io` stream has been growing for ~70 minutes.
- `maxLen: 50000` was configured (`socket.ts:40`) — we are not at it
  yet, but with enough activity we will be.
- `groups: 0` — the adapter does not use Redis consumer groups, just
  in-memory cursors per replica. After a pod restart, the new pod
  resumes from `$` (latest), losing whatever was written during the
  restart window.

This is not an immediate-fire bug but it (a) means events written
during a pod restart are lost cross-replica, and (b) at higher load
will trigger XADD trimming and increase Redis pressure.

## What I could not reproduce locally

- **`transport close` storms with no apparent pod activity** (the
  user's prod symptom). My local minikube only produces `transport
  close` from explicit `kubectl delete pod`. Possible prod sources I
  didn't get to:
  - Cluster ingress / LB idle-timeout closing long-lived websockets
  - K8s liveness probe killing pods on slow `/health` (not seen here
    — `/health` is fast)
  - OOMKill from Redis adapter buffering or pino logging
  - Server-side ping timeout because event loop is blocked by the
    `refreshRpcRegistrations` SCAN+pipeline path on heavy users
- **Network-blackout effects:** `iptables -I OUTPUT -d <redis>`
  applied via `kubectl debug --profile=netadmin --target=handy` did
  not visibly affect ongoing RPCs in my run. Either kube-proxy
  rewrites the destination before my rule, or conntrack ESTABLISHED
  state is bypassing the drop, or the streams adapter buffers
  gracefully through brief outages. Needs deeper packet capture work.

## Why the original commits believed it worked

`9e9e5f4f`'s test plan was steady-state cross-pod RPC with both
sockets connected and no churn. That's exactly the slice that **does**
work. The bugs all live in transitions: pod kill, reconnect, TTL roll.
None of them appear in a 10-second smoke test of "send RPC, get reply."

`888b87a3`'s "tested on real LB, 216 events/sec, 49ms disconnect
detection" tests broadcast fan-out only — **never RPC routing**. That
is also the slice that works.

The fixes were shipped in sequence each catching the previous bug's
shape, but none of them stress-tested the actual problem class:
**RPC routing identity is tied to a transient socketId, and there is
no atomic update path across daemon socket transitions.**

## Minimum-viable fix candidates

I am NOT writing code yet — these are sketches for the next
conversation.

1. **Re-register on every reconnect** (client side, daemon)
    - Already done by happy-cli for fresh connects but the
      *reconnect* path may not hit register again. Verify
      `rpcRegistry` re-fires on `socket.connect` after disconnect.
    - Cheap, doesn't fix in-flight calls but stops bug #3 from
      sticking.

2. **Index registrations by `socketId → [methods]` on each pod**
    - Rebuild authoritative cleanup on disconnect without depending
      on TTL.
    - Drop the 60s TTL entirely, or raise it to e.g. 1 hour and
      treat as a janitor-only safety net.

3. **Fast-fail RPC when target socket is gone**
    - Before `io.to(socketId).emitWithAck`, do a cheap presence
      check via the adapter. If no pod claims the socketId, return
      `'RPC target not reachable'` immediately instead of waiting
      30s.
    - The adapter exposes `fetchSockets({rooms: [socketId]})` for
      this. Costs one Redis round trip per call.

4. **Stop routing by socketId; route by stable method-name channel**
    - Daemon subscribes to `rpc:method:<userId>:<method>` Redis
      pub/sub channel.
    - Caller publishes a request envelope `{requestId, params, replyTo}`.
    - Daemon publishes response to `replyTo`.
    - Decouples from socketId entirely. Reconnects don't lose RPC
      identity. This is the "clean" fix; it's a bigger refactor.

5. **Sticky daemon-aware routing**
    - Route any user's RPC calls to the pod that hosts that user's
      daemon. k8s `Service` with `sessionAffinity: ClientIP` per-user
      hash. Means cross-pod RPC ≈ never happens. Smaller blast
      radius without the protocol redesign.

## Repro inventory (in `deploy/`)

| File                          | Purpose |
|-------------------------------|---------|
| `local.sh`                    | Bring up minikube + 2-replica stack |
| `test-multiprocess.mjs`       | Broadcast fan-out + pod-kill recovery |
| `test-rpc-cross-replica.mjs`  | Steady-state cross-pod RPC |
| `hammer.mjs`                  | Bug repros: pod-kill / reconnect-storm / ttl-expiry |
| `network-loss.mjs`            | Long-running RPC loop with summary, used with iptables |
| `probe-rpc.mjs`               | Direct rpc-register + Redis-key inspector |
| `POSTMORTEM.md`               | This file |
