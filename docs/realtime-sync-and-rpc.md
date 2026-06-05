# Realtime Sync and RPC

This is the high-level doc for how Happy uses Socket.IO for realtime sync and point-to-point RPC.

Related docs:
- `protocol.md`: wire contract, event names, and payload shapes
- `multi-process.md`: deeper notes about cross-replica behavior, failure modes, and test history
- `backend-architecture.md`: server subsystem overview
- `cli-architecture.md`: daemon and client-side socket ownership

## Core Pieces

Happy uses one Socket.IO endpoint at `/v1/updates` and three connection scopes:
- `user-scoped`: app/web clients and account-wide listeners
- `session-scoped`: one live session process
- `machine-scoped`: one daemon for one machine

On the server:
- `socket.ts` authenticates the handshake, tags the socket with `userId` and scope metadata, and enables the Redis streams adapter when `REDIS_URL` is set.
- `eventRouter.ts` handles fan-out for normal realtime updates.
- `rpcHandler.ts` handles `rpc-register`, `rpc-unregister`, and `rpc-call`.

On the client side:
- `ApiSessionClient` owns a long-lived session-scoped socket.
- `ApiMachineClient` owns a long-lived machine-scoped socket.
- the app's `apiSocket` owns a long-lived user-scoped socket.
- `RpcHandlerManager` registers handlers and re-registers them on reconnect.

## Room Model

Normal fan-out rooms:
- `user:<userId>`
- `user:<userId>:user-scoped`
- `user:<userId>:session:<sessionId>`
- `user:<userId>:machine:<machineId>`

RPC registration rooms:
- `rpc:<userId>:<prefixedMethod>`

The server uses room membership as the source of truth for who currently owns an RPC method.

## Realtime Sync Flow

1. A client connects with a scope (`user-scoped`, `session-scoped`, or `machine-scoped`).
2. The server adds that socket to the appropriate user/session/machine rooms.
3. When durable state changes, `eventRouter` emits `update` events to the matching rooms.
4. When transient presence changes, the server emits `ephemeral` events to the matching rooms.
5. On reconnect, clients can re-fetch state if they missed anything while offline.

## RPC Flow

1. A caller emits `rpc-call` with a method name and params.
2. `rpcHandler.ts` resolves the room `rpc:<userId>:<method>`.
3. The server looks for a target socket in that room.
4. If no target is present, the server waits briefly for reconnect before failing.
5. If a target is present, the server forwards the request with `rpc-request`.
6. The target runs the handler through `RpcHandlerManager` and acks the result.
7. If the target disappears mid-call, the server fails the call instead of waiting for the full timeout.

This is how Happy does point-to-point control traffic on top of the same transport used for normal realtime sync.

## Current Sharp Edges

- `packages/happy-agent/src/machineRpc.ts` still creates one-off caller sockets for machine `spawn` and `resume` instead of reusing a long-lived caller connection.
- `packages/happy-server/sources/app/api/socket/rpcHandler.ts` still mixes room lookup, reconnect grace, mid-call presence checking, and metric emission in one place.

## Debugging

If this path is flaky, the first things to check are:
- RPC success/failure rate
- RPC latency
- websocket connection churn
- Redis stream lag

Use `multi-process.md` for the deeper cross-replica and failure-mode details.
