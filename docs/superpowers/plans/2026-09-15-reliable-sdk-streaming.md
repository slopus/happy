# Reliable SDK subscriptions and Codex streaming

## Authorized scope

Fix missing batched messages, reconnect history recovery, MISS subscription integration, and Codex partial text delivery. Work in sibling worktrees; preserve the existing MISS discussions implementation. No production restarts or releases are part of local verification.

## Contracts

- Durable messages remain encrypted database records with per-session `seq`.
- `messages.historyPage(sessionId, { afterSeq?, beforeSeq?, limit?, signal? })` returns `{ messages, hasMore }`.
- `messages.watch(sessionId, { afterSeq, onMessage, onError?, signal? })` returns `Promise<{ unsubscribe(): void; sync(): Promise<void> }>`.
- A watcher attaches before initial catch-up, delivers messages in contiguous ascending sequence order once per watcher, and reconciles active subscriptions before reconnect `ready`.
- The server's existing batched `new-message` notification remains a watermark. Gaps trigger forward paging, not periodic tail polling.
- Ephemeral Socket.IO `session-stream` carries `{ sid, content: { t: 'encrypted', c } }`. Only the authenticated session worker may produce it for its own session; authorized account/session recipients receive it.
- Decrypted stream payload is `{ type: 'text-delta', turnId, itemId, delta, text }`. `text` is a cumulative item snapshot so a later event repairs dropped provisional chunks. It is not durable history or a completion signal.
- SDK exposes that payload with `sessionId` through `client.subscribe`. Final persisted text replaces provisional item text; `turn-end` determines completion.
- MISS emits `text-update` with cumulative display text and an explicit `done` frame. Browser EOF without `done` is interrupted, not successful.

## Parallel tasks

### SDK — packages/paws-agent

- [x] Reproduce batch gaps, overlapping events and missing reconnect messages against a local HTTP/Socket.IO fixture.
- [x] Implement paginated history and serial per-session watchers; cancellation closes reads and listener resources.
- [x] Validate/decrypt ephemeral text updates; preserve the low-level subscription API and document its semantics.
- [x] Run SDK tests and build; exercise more than 500 records and disposal during catch-up.

### Producer and relay — packages/happy-cli, happy-wire, happy-server

- [x] Reproduce missing Codex `item/agentMessage/delta` handling before item completion.
- [x] Add bounded live text accumulation and encrypted ephemeral transport. Preserve whitespace and existing final-message persistence.
- [x] Enforce sender session ownership, ciphertext bounds and authorized recipient routing.
- [x] Verify event ordering, completion cleanup and unauthorized send rejection with focused tests.

### Consumer — MISS sibling worktree

- [x] Reproduce premature completion, incomplete history, missing explicit done and stream cancellation.
- [x] Adopt reliable watchers and per-turn/item provisional text reconciliation, preserving user/video/discussion isolation.
- [x] Handle SSE framing, disconnects and bounded response buffering; retain pending state when a submitted turn is uncertain.
- [x] Run all MISS tests with the newly built SDK candidate.

### Integration — parent

- [x] Review all three implementations for contract and lifecycle mismatches.
- [x] Exercise actual SDK + MISS over local HTTP/Socket.IO with encrypted server-shaped messages: partial output before completion, coalesced batch and replay after disconnect; separately verify session/account isolation in consumer and relay tests.
- [x] Run touched package typechecks/builds and relevant regression suites.
- [x] Record exact validation, candidate artifact and deployment requirements; verify Happy root stays clean and aligned with origin/main.

## Final local verification (2026-09-15)

| Layer | Result |
| --- | --- |
| SDK | Build/typecheck passed; clean full run: 29 files, 288 tests via `pnpm exec vitest run --maxWorkers=1 --testTimeout=15000`. |
| CLI | 155 targeted tests passed (50 app-server, 50 API, 55 mapper); typecheck and final atomic build passed; version smoke returned 1.3.10; build lock removed naturally. |
| Wire | 10 tests and build passed. |
| Server | 7 stream security/order/bounds tests and 3 existing route tests passed; final typecheck, runtime bundle and `--help` smoke passed. |
| MISS | Fresh `npm ci --ignore-scripts` installed the pinned candidate; 26 unit tests and 2 actual-SDK/HTTP/Socket.IO/SSE-parser integration tests passed. |
| Review/workspace | Cross-component reviews completed; confirmed important findings fixed with regressions; both diff checks passed; Happy root remained clean at `33d8c787a0d2d7a7ef2363a103843d44f4b6959b`, equal to origin/main. |

Validation environment notes: inherited `HAPPY_CODEX_ACCOUNT_PROFILE_ID` was unset for CLI transport fixtures. An initial SDK run encountered CPU-load timeouts; the final single-worker full run above passed without unhandled errors. The server host lacked Bun, so its unchanged build script was run via isolated `npm exec --yes --package=bun@1.2.22 -- node scripts/build-runtime.cjs`; no global installation or dependency change was needed.

## Additional defects confirmed during implementation

- The CLI live outbox drained newest batches first. A backlog larger than 50 could commit terminal events before earlier body text. It now drains FIFO, with a 100+ message regression.
- A notification arriving between watch drain completion and its promise finalizer could be stranded until another notification. Finalization now chains any newly requested catch-up.
- Slow metadata/key/ownership reads could accumulate unbounded transient snapshots. SDK and relay queues now have count and ciphertext-byte bounds; previews retain the latest available cumulative snapshots.
- Late duplicate Codex item completion could persist duplicate final text after its turn ended. Finalized root-turn filtering now covers this case.

## Deployment and correlation boundaries

This work changes local source and produces local artifacts only. It does not restart the existing daemon, publish npm packages, merge into production main, deploy the server or gateway, or verify a real model/browser session.

True partial text requires the matching Codex CLI producer, Happy server relay, SDK and MISS consumer. The candidate SDK alone repairs durable delivery but cannot synthesize missing producer deltas. Existing raw `subscribe` remains best-effort; use `messages.watch` for durable delivery.

MISS discussions use dedicated Paws sessions. The upstream turn-start does not carry the submitted localId, so externally concurrent submissions to the same session are not unambiguously correlated. Legacy pending discussions without recorded submission identity remain pending for manual inspection. These are explicit protocol/migration boundaries, not claims of fixed behavior.

The MISS sibling worktree preserves the original checkout's pre-existing discussions/user-isolation changes. Its local SDK tarball is `vendor/paws-agent-reliable-streaming-883734ba.tgz`, pinned in package.json and lockfile (package metadata remains baseline beta.2; no public beta.2 release was replaced).
