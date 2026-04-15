# Multi-process happy-server

How handy-server runs across multiple Kubernetes replicas: socket distribution,
room-based RPC routing, broadcast fan-out, daemon lifecycle, and what happens
during the messy cases (pod kill, brief reconnect, network partition).

> **Status:** the code in this doc is on `main` but `handy.yaml` ships
> `replicas: 1`. Flipping prod to multi-replica is a separate decision.

## TL;DR

handy-server uses the **Socket.IO Redis streams adapter** to forward
`io.to(...).emit(...)` between replicas through a single Redis stream. RPC
routing (web → daemon) goes through **Socket.IO rooms** named
`rpc:<userId>:<method>`. The server resolves the daemon socket via
`io.in(room).fetchSockets()` (the cluster-adapter primitive that works
cross-replica), and sends the request to a single RemoteSocket. There is **no
Redis key, no TTL, no Lua-CAS cleanup, no keep-alive refresh path** —
membership is standard Socket.IO room state, cleaned up automatically on
disconnect.

If the daemon is briefly offline at call time (k8s pod cycling, transient
network drop), the server **waits up to 10 seconds** for it to reappear before
failing. If the daemon is in flight when its socket dies, a **presence poll**
aborts the call within ~1 second instead of waiting the full 30s
emit-with-ack timeout.

`connectionStateRecovery` is **commented out** in `socket.ts`. The streams
adapter supports it (verified working) but we ship parity with the
pre-multi-process behavior first; clients still do a full REST re-fetch on
every reconnect via `apiSocket.onReconnected`.

## What an rpc-call does (control flow)

```
rpc-call from web client
.
├── input validation
│   └── method name → invalid → callback({ok:false, error:'Invalid parameters'})
│
├── 1. resolve target via cluster adapter
│   └── fetchRoomSockets(io, 'rpc:<userId>:<method>')
│       ├── io.in(room).timeout(500ms).fetchSockets()
│       ├── on success → returns [...]
│       └── on failure (peer replica unresponsive, fast adapter timeout)
│           └── log + return [] (treat as "nobody here")
│       │
│       ├── returns [target] → go to step 2
│       └── returns []      → go to wait-for-reconnect
│
├── wait-for-reconnect grace (only when no target found)
│   └── waitForRoomMember(io, room, 10_000ms)
│       └── poll every 200ms via fetchRoomSockets:
│           ├── room gained a member → return [target]
│           └── deadline reached     → return []
│       │
│       ├── grace produced [target] → go to step 2
│       └── grace produced []
│           └── callback({ok:false, error:'RPC method not available'})
│
├── 2. sanity checks on resolved target
│   ├── multiple sockets in room → log warn, use first
│   └── target.id === socket.id  → callback({ok:false, error:'same socket'})
│
├── 3. fire emit + race a presence poll
│   ├── ackPromise = target.timeout(30_000).emitWithAck('rpc-request', ...)
│   │   (cluster adapter routes cross-replica via Redis stream)
│   │
│   └── presencePoll = while (alive)
│       └── sleep 1s, fetchRoomSockets again
│           ├── target still in room → keep watching
│           └── target absent       → throw 'RPC target disconnected'
│
├── Promise.race(ackPromise, presencePoll)
│   ├── ackPromise resolves → callback({ok:true, result})
│   ├── ackPromise throws (timeout / err) → callback({ok:false, error: msg})
│   └── presencePoll throws → callback({ok:false, error:'RPC target disconnected'})
│
└── finally
    └── presenceAlive = false  (stops the poll cleanly on success or failure)
```

## What a daemon does (lifecycle)

```
daemon (machine-scoped or session-scoped)
.
├── connect to handy-server
│   └── server: socket.handshake.auth.token → auth.verifyToken
│       └── attaches rpcHandler / *UpdateHandler / etc
│
├── emit('rpc-register', { method })
│   └── server: socket.join('rpc:<userId>:<method>')
│       └── ack: emit('rpc-registered', { method })
│       (Socket.IO room state, NO Redis key, NO TTL)
│
├── on('rpc-request', (data, cb) => …)
│   └── handler runs, cb(result) returns the value via the cluster adapter
│
├── disconnect (any reason)
│   └── Socket.IO automatically removes the socket from all rooms
│       (cluster adapter syncs via heartbeat; no manual cleanup needed)
│
└── auto-reconnect
    └── on 'connect': re-emit rpc-register
        (the only client-side responsibility)
```

## What a broadcast does (event emission)

```
eventRouter.emitUpdate / emitEphemeral
.
└── io.to(rooms).emit('update' | 'ephemeral', payload)
    ├── streams adapter: XADD on the 'socket.io' Redis stream
    │   (MAXLEN ~ 50000, auto-trimmed by Redis)
    └── every replica's XREAD loop picks up the entry
        └── delivers to its local sockets that match the room set
            (sockets that disconnected before the emit miss it; client
             falls through to apiSocket onReconnected → REST refetch)
```

Rooms used by `eventRouter`:

```
.
├── user:<userId>                              all of a user's sockets
├── user:<userId>:user-scoped                  only the web/desktop clients
├── user:<userId>:session:<sessionId>          session-scoped subscribers
└── user:<userId>:machine:<machineId>          one specific machine
```

## Where the code lives

```
.
├── packages/happy-server/sources/app/
│   ├── api/socket.ts                      io.Server setup, attaches the
│   │                                       streams adapter when REDIS_URL
│   │                                       is set, commented-out
│   │                                       connectionStateRecovery
│   ├── api/socket/rpcHandler.ts           the entire RPC routing layer
│   │                                       (~180 lines, single code path)
│   ├── api/socket/machineUpdateHandler.ts no longer touches RPC state
│   ├── api/socket/sessionUpdateHandler.ts no longer touches RPC state
│   └── events/eventRouter.ts              broadcast emission via rooms
│
└── packages/happy-server/deploy/handy.yaml  k8s Deployment + Service
                                             (replicas: 1 in this PR)
```

## What was wrong before (the four bugs)

The previous attempt stored RPC routing state as `rpc:user:<u>:method:<m>` →
socketId Redis keys with a 60-second TTL refreshed by `machine-alive` /
`session-alive` heartbeats. This had three killer bugs (smoking gun was #3):

```
.
├── #1  In-flight RPC eats the full 30s timeout when the target pod dies
│       io.to(deadSocketId).emitWithAck() has no fast-fail.
│       FIX: presence poll aborts within ~1s
│
├── #2  Reconnect race
│       Between the daemon's disconnect cleanup and re-register, ~5–7% of
│       cross-pod RPCs fail with either "method not available" (key
│       deleted) or "target not reachable" (key still pointed at dead
│       socketId).
│       FIX: atomic socket.join / auto-leave on disconnect, no race window
│
├── #3  Silent TTL expiry
│       Daemon stays connected, registration vanishes after 60s if the
│       keep-alive event was missed for any reason. Daemon never knows;
│       stays broken until reconnect.
│       FIX: no TTL exists anymore
│
└── #4  Streams adapter "unbounded growth"
        FALSE ALARM. The adapter trims with MAXLEN ~ on every XADD. Capped
        at ~50k entries. Crossing this off the list.
```

The full postmortem with reproduction commands is at
`deploy/integration-tests/POSTMORTEM.md`.

## How we tested it

Local minikube with a 2-replica handy-server, Redis, Postgres, exposed as a
real `LoadBalancer` service via `minikube tunnel`. All harnesses live in
`deploy/integration-tests/`.

```
.
├── test-rpc-cross-replica.mjs   steady-state cross-pod RPC
│                                 (50 parallel + 20 sequential)
├── test-multiprocess.mjs        broadcast fan-out + pod-kill recovery
├── hammer.mjs <scenario>        pod-kill-mid-rpc, reconnect-storm,
│                                 ttl-expiry, brief-disconnect,
│                                 long-disconnect
├── network-loss.mjs             long-running RPC loop with summary,
│                                 usable with iptables blackouts
├── missed-events.mjs            brief disconnect → triggered broadcast →
│                                 reconnect; verifies missed-events
│                                 behavior matches main (lost from socket,
│                                 recovered via REST refetch)
├── probe-rpc.mjs                direct rpc-register sanity probe +
│                                 Redis key inspector
├── probe-fetchsockets.mjs       fetchSockets latency probe
├── POSTMORTEM.md                full bug-by-bug
└── ../local.sh                  bring up the whole minikube stack
```

To bring up the test environment from scratch:

```bash
deploy/local.sh                                        # provisions stack
kubectl get pods -l app=handy-server                   # confirm 2 replicas
kubectl patch svc handy-server -p '{"spec":{"type":"LoadBalancer"}}'
minikube tunnel &                                      # exposes :3000
node deploy/integration-tests/test-rpc-cross-replica.mjs
```

Final gauntlet result against the fix:

```
.
├── steady-state cross-pod RPC          50/50 + 20/20 ✅ (after ~5s warmup)
├── pod-kill-mid-rpc                    1612ms fast-fail ✅ (was 30000ms)
├── brief-disconnect                    SUCCESS in 2011ms ✅
├── long-disconnect                     bounded 10542ms ✅ (10s grace + ~0.5s)
├── ttl-expiry (smoking gun)            ALL 5 calls pass through +75s ✅
├── reconnect-storm (5 cycles)          96–97% success ✅ (only inherent
│                                         in-flight failures, ~3%)
├── broadcast multi-process             20/20 fan-out, 5/5 unaffected ✅
├── network-loss 60s loop               85/85 zero failures ✅
└── missed-events parity                event lost via socket, in DB,
                                        recovered=undefined ✅ (matches main)
```

## Tunable constants

```
RPC_RECONNECT_GRACE_MS        10_000   wait-for-reconnect window (2× heartbeat)
RPC_RECONNECT_POLL_MS            200   poll cadence inside the grace
RPC_PRESENCE_POLL_MS           1_000   presence-poll cadence during in-flight
RPC_PRESENCE_FETCH_TIMEOUT_MS    500   per-call cross-replica fetchSockets cap
RPC_CALL_TIMEOUT_MS           30_000   upper bound on emitWithAck — same as main
                                       (no support for >30s RPCs in either)
```

## Adapter details and limits worth knowing

```
.
├── streams adapter discovery
│   ~5s after a pod starts, the adapter's heartbeat exchange means
│   cross-replica fetchSockets() may not see all rooms. First few RPCs
│   immediately after a fresh rollout can hit the wait-for-reconnect
│   grace; we sized RPC_RECONNECT_GRACE_MS at 10s to cover 2 heartbeat
│   cycles.
│
├── MAXLEN ~ 50000
│   configured in socket.ts. Auto-trims on every XADD, no cleanup needed.
│
├── fetchSockets() cross-replica
│   defaults to a 5-second timeout per request. We pass timeout(500) for
│   our presence polls so a single unresponsive replica doesn't stall
│   every poll for 5s.
│
├── emitWithAck from a RemoteSocket
│   works cross-replica through the cluster adapter (the streams adapter
│   inherits ClusterAdapterWithHeartbeat which implements BROADCAST_ACK
│   and FETCH_SOCKETS_RESPONSE).
│
└── multiple sockets in the same RPC room
    shouldn't happen in practice (one daemon per machine, one method
    registration). If it does, we log a warn and pick targets[0]. Same
    blast radius as the previous Redis last-write-wins behavior.
```

## What we still don't do (intentional, deferred)

```
.
├── connectionStateRecovery
│   Commented out in socket.ts. Enabling it would let brief disconnects
│   skip the heavy REST refetch (events replay through the streams
│   adapter via restoreSession). Verified working — not shipped to
│   preserve parity with main on this dimension.
│
├── In-flight RPC continuity across daemon reconnect
│   Coupled to the above. With connectionStateRecovery enabled AND a
│   recovery-aware presence poll (i.e. "wait N seconds for the same
│   socketId to come back before failing"), an in-flight RPC could
│   survive a brief network blip on the daemon: the daemon's handler
│   keeps running, the ack packet sits in the client's sendBuffer,
│   reconnect flushes it, the caller gets its result. Today the presence
│   poll fast-fails the call as soon as the room is empty, which kills
│   this case. Out of scope for this PR.
│
├── User-affinity routing at the LB
│   Cross-pod RPC overhead is ~3–6ms via the streams adapter. JWT-aware
│   routing (Envoy / Istio / nginx-lua) would be a bigger infra change
│   than the fix itself. Tracked as future-work.
│
├── UI "reconnecting…" indicator
│   Server now waits 10s for daemons. Client doesn't yet show that wait
│   in the UI. apiSocket-side change, separate from this PR.
│
├── Tuning the adapter discovery window
│   5s is the streams adapter's default heartbeatInterval. Lowering it
│   would reduce the fresh-pod-startup race but increase Redis chatter.
│
└── Long-running RPCs (> 30s)
    Not supported on either main or this PR. Bash command in the CLI has
    its own 30s cap that races dead-even with the server's 30s emit
    timeout. Bumping requires both server and (possibly added) client
    timeouts.
```

## Reference

- Socket.IO rooms: <https://socket.io/docs/v4/rooms/>
- `fetchSockets()`: <https://socket.io/docs/v4/server-api/#serverfetchsockets>
- Broadcasting events: <https://socket.io/docs/v4/broadcasting-events/>
- Memory usage: <https://socket.io/docs/v4/memory-usage/>
- Streams adapter source: <https://github.com/socketio/socket.io-redis-streams-adapter>
- Connection state recovery: <https://socket.io/docs/v4/connection-state-recovery>
- Discussion #5062 (broadcast emitWithAck waits for all): <https://github.com/socketio/socket.io/discussions/5062>
