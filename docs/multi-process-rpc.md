# Multi-process Socket.IO + RPC routing

## TL;DR for a human

The handy-server runs as multiple Kubernetes replicas behind a load balancer.
Web clients and CLI daemons connect to whichever replica the LB picks. To make
realtime work across replicas we use the **Socket.IO Redis streams adapter**,
which forwards `io.to(...).emit(...)` and friends through a single Redis
stream. Any replica can broadcast; every replica delivers to its local
sockets in matching rooms.

For RPC (web client → CLI daemon over the websocket), the daemon registers a
named method by **joining a Socket.IO room** (`rpc:<userId>:<method>`). When a
caller invokes the RPC the server resolves the daemon socket via
`io.in(room).fetchSockets()` (works cross-replica via the same adapter) and
sends the request to that single RemoteSocket. There is **no Redis key, no
TTL, no separate Lua-CAS cleanup, and no keep-alive refresh path** —
membership is just standard Socket.IO room state, cleaned up automatically on
disconnect.

If the daemon is briefly offline at call time (k8s pod cycling, transient
network drop) the server **waits up to 5 seconds** for it to reappear before
failing the call. If the daemon is in flight when its socket dies, a presence
poll aborts the call within ~1 second instead of waiting the full 30s
emit-with-ack timeout.

Reconnect-replay (`connectionStateRecovery`) is **commented out** in
`socket.ts`. The streams adapter supports it (verified working) but we ship
parity with the pre-multi-process behavior first; clients still do a full
REST re-fetch on every reconnect via `apiSocket.onReconnected`.

## Where the code lives

- `packages/happy-server/sources/app/api/socket.ts` — `io.Server` setup,
  attaches the streams adapter when `REDIS_URL` is set
- `packages/happy-server/sources/app/api/socket/rpcHandler.ts` — the entire
  RPC routing layer (~110 lines, single code path)
- `packages/happy-server/sources/app/events/eventRouter.ts` — broadcast/event
  emission via Socket.IO rooms (`user:<id>`, `user:<id>:user-scoped`,
  `user:<id>:session:<sid>`, `user:<id>:machine:<mid>`)
- `packages/happy-server/deploy/handy.yaml` — k8s Deployment + Service

## How RPC works end-to-end

1. **Daemon connects** as `clientType: machine-scoped` (or session-scoped) and
   emits `rpc-register` with a method name. Server runs
   `socket.join('rpc:<userId>:<method>')` and acks `rpc-registered`.
2. **Web client connects** as `clientType: user-scoped` and emits `rpc-call`
   with `{method, params}`.
3. Server resolves the target with
   `io.in(room).timeout(500).fetchSockets()`.
   - Empty → poll every 200ms for up to 5s (the **wait-for-reconnect grace**)
     so a daemon that's mid-reconnect transparently recovers
   - Still empty after grace → fail fast with `RPC method not available`
4. Server sends to the single target with
   `target.timeout(30000).emitWithAck('rpc-request', {method, params})`.
5. In parallel, a **presence poll** runs every 1s checking that the target
   is still in the room. If the target leaves (pod death, daemon disconnect),
   the call aborts with `RPC target disconnected` instead of waiting 30s.
6. Daemon's `rpc-request` listener returns its result via the ack callback;
   the value flows back across replicas via the adapter and resolves the
   caller's `emitWithAck`.

## How event broadcasts work

`eventRouter.emit*` calls `io.to(rooms).emit(...)`. The streams adapter does
`XADD` (with `MAXLEN ~ 50000`) on the `socket.io` Redis stream. Every replica
runs an `XREAD` loop, picks up new entries, and delivers to its local
sockets in those rooms. Same code path on a single instance — minus Redis.

## What was wrong before (the four bugs)

The previous attempt stored RPC routing state as `rpc:user:<u>:method:<m>` →
socketId Redis keys with a 60-second TTL refreshed by `machine-alive` /
`session-alive` heartbeats. This had three killer bugs (smoking gun was #3):

1. **In-flight RPC eats the full 30s timeout** when the target pod dies —
   `io.to(deadSocketId).emitWithAck()` has no fast-fail.
2. **Reconnect race**: between the daemon's disconnect cleanup and re-register,
   ~5–7% of cross-pod RPCs fail with either `method not available` (key
   deleted) or `target not reachable` (key still pointed at dead socketId).
3. **Silent TTL expiry**: daemon stays connected, registration vanishes after
   60s if the keep-alive event was missed for any reason. Daemon never knows;
   stays broken until reconnect.

(Bug #4 — "streams adapter unbounded growth" — was a misread on my part. The
adapter trims with `MAXLEN ~` on every `XADD`. Capped at ~50k entries.)

The full postmortem with reproduction commands is at
`deploy/integration-tests/POSTMORTEM.md`.

## How we tested it

Local minikube with a 2-replica handy-server, Redis, Postgres, exposed as a
real `LoadBalancer` service via `minikube tunnel`. All harnesses live in
`deploy/integration-tests/`.

| Script | What it covers |
|---|---|
| `test-rpc-cross-replica.mjs` | Steady-state cross-pod RPC: 50 parallel + 20 sequential |
| `test-multiprocess.mjs` | Broadcast fan-out + pod-kill recovery |
| `hammer.mjs <scenario>` | `pod-kill-mid-rpc`, `reconnect-storm`, `ttl-expiry`, `brief-disconnect`, `long-disconnect` |
| `network-loss.mjs` | Long-running RPC loop with summary; usable with iptables blackouts |
| `missed-events.mjs` | Brief disconnect → triggered broadcast → reconnect; verifies missed-events behavior matches main (lost from socket, recovered via REST refetch) |
| `probe-rpc.mjs` | Direct rpc-register sanity probe + Redis key inspector |
| `local.sh` | Bring up the whole minikube stack from scratch |

To bring up the test environment from scratch:

```bash
deploy/local.sh                                          # provisions stack
kubectl get pods -l app=handy-server                     # confirm 2 replicas
kubectl patch svc handy-server -p '{"spec":{"type":"LoadBalancer"}}'
minikube tunnel &                                        # exposes :3000
node deploy/integration-tests/test-rpc-cross-replica.mjs # smoke test
```

Key result against the fix (single run, fresh pods, after 5–10s adapter
discovery window):

```
hammer pod-kill-mid-rpc      30s timeout → 1.6s fast-fail   (-94%)
hammer brief-disconnect      lost → SUCCESS in 1.95s        (NEW)
hammer long-disconnect       lost → bounded fail in 5.5s
hammer ttl-expiry            fails at +65s → ALL pass
hammer reconnect-storm       6.3% fail rate → 2.3% (only inherent in-flight)
network-loss 60s loop        5 fails at +60s → 0 fails
test-rpc-cross-replica       50/50 + 20/20 (×5 runs)
test-multiprocess            20/20 broadcast fan-out
missed-events                LOST (parity, recovery commented out)
                             RECOVERED when uncommented (verified)
```

## Adapter details and limits worth knowing

- **Streams adapter discovery**: ~5s after a pod starts, the adapter's
  heartbeat exchange means cross-replica `fetchSockets()` may not see all
  rooms. First few RPCs immediately after a fresh rollout can fast-fail.
- **`MAXLEN ~ 50000`**: configured in `socket.ts`. Auto-trims, no manual
  cleanup needed.
- **`fetchSockets()` cross-replica**: defaults to a 5-second timeout per
  request. We pass `timeout(500)` for our presence polls so a single
  unresponsive replica doesn't stall every poll for 5s.
- **`emitWithAck` from a `RemoteSocket`**: works cross-replica through the
  cluster adapter (the streams adapter inherits `ClusterAdapterWithHeartbeat`
  which implements `BROADCAST_ACK` and `FETCH_SOCKETS_RESPONSE`).
- **Multiple sockets in the same RPC room**: shouldn't happen in practice
  (one daemon per machine, one method registration). If it does, we log a
  warn and pick `targets[0]`. Same blast radius as the previous Redis
  last-write-wins behavior.

## What we still don't do (intentional, deferred)

- **`connectionStateRecovery`**: commented out in `socket.ts`. Enabling it
  would let brief disconnects skip the heavy REST refetch (events replay
  through the streams adapter via `restoreSession`). Verified working — not
  shipped to preserve parity with main on this dimension.
- **UI "reconnecting…" indicator**: out of scope for the server fix. The
  server now patiently waits 5s for a daemon to reappear before failing,
  but the client doesn't yet show that wait state in the UI.
- **Tuning the adapter discovery window**: 5s is the streams adapter's
  default `heartbeatInterval`. Lowering it would reduce the
  fresh-pod-startup race but increase Redis chatter.

## Reference

- Socket.IO rooms: <https://socket.io/docs/v4/rooms/>
- `fetchSockets()`: <https://socket.io/docs/v4/server-api/#serverfetchsockets>
- Broadcasting events: <https://socket.io/docs/v4/broadcasting-events/>
- Memory usage: <https://socket.io/docs/v4/memory-usage/>
- Streams adapter source: <https://github.com/socketio/socket.io-redis-streams-adapter>
- Connection state recovery: <https://socket.io/docs/v4/connection-state-recovery>
- Discussion #5062 (broadcast emitWithAck waits for all): <https://github.com/socketio/socket.io/discussions/5062>
