# Agent Browser daemon attention (S3 / D10)

Status: implemented; targeted verification passed; deployment acceptance still pending.
Updated: 2026-09-25. Base: `f9d4f6a2` (`feat/abp-s2-auth`).

## Operation

`run.ts` starts the watcher after session recovery/startup and stops it before
shutdown. The configuration reader is shared with S2's session broker:
`HAPPY_BROWSER_TASK_BROKER_SOCKET` plus a readable, nonempty
`HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE` (default `/var/lib/abp/daemon-token`).
The broker token is used only in `x-abp-daemon-token`; session posts use the
tracked session's staged account token when present, otherwise the daemon's
account token. Missing staged credentials never fall back to another identity.

The watcher polls `/v1/attention?afterSeq=…&waitMs=30000`. It processes one
bounded batch sequentially and sends only the Desktop PoC follow-up text:

```
[agent-browser] task <taskId> status=<status> eventSeq=<eventSeq>. Call getTask for the current state before continuing.
```

Messages reuse the existing daemon user-message wire/encryption path
(`byosOfflineReceiveWiring.ts`, `autonomousQualityGateMessageSender.ts`) and
`apiSession.ts:readMessageAck`. The payload has role `user`, text content,
`localKey` equal to localId, and daemon/source metadata. A successful HTTP status
alone is insufficient: the reply must identify this localId with a valid message
id and positive sequence. Only live `startedBy: 'daemon'` tracked sessions are
sent messages; ended/unowned sessions are skipped. Missing live encryption is a
retryable failure. Sessions recovered by the daemon retain their spawn identity.

The cursor is stored under
`$HAPPY_HOME_DIR/browser-attention/<sha256(serverUrl,machineId,socketPath)>.json`.
Writes use an exclusive 0600 temporary file, file fsync, rename, and directory
fsync. Each acknowledged ordinary event checkpoints independently. Expired
snapshots checkpoint only after all entries are acknowledged/skipped, including
when a replacement Runtime has a lower sequence. Replays always use
`abp-<taskId>-<eventSeq>`. Corrupt cursors fail closed and back off; they are never
silently reset. Removing a cursor intentionally causes a deduplicated replay.

No sent-id cache or external dependencies. Bounds: 1 MiB network replies,
1,000 feed/snapshot entries (S2 default outbox retention), 128 KiB cursor reads,
100 recent skip records. Older skip records are intentionally evicted. Transport
and delivery failures back off 1s, 2s, … up to 300s, resetting on successful polls.
A 1s floor also prevents immediate empty replies from spinning. Requests and retry
sleeps are cancellable; broker requests have a 35s absolute deadline, and server
posts have a 30s timeout. Raw transport errors and credentials are not logged.

## Server deduplication evidence

Read the vendor implementation at the S2 base, without changing server files:

- `packages/happy-server/sources/app/api/routes/v3SessionRoutes.ts:161` starts a
  transaction, queries existing messages by sessionId + localId, and filters
  existing localIds before allocating sequences/inserting (`:184`). `:212`
  combines existing and newly created messages into the acknowledgement.
- `packages/happy-server/prisma/schema.prisma:156` has
  `@@unique([sessionId, localId])`. Concurrent duplicate inserts cannot both
  commit. A uniqueness conflict may fail one request; retry finds the existing
  row and obtains its acknowledgement.
- The route announces only `createdMessages` (`:224`), so a normal duplicate
  request does not emit another new-message notification.
- Existing `v3SessionRoutes.test.ts` tests repeated localIds in one batch,
  existing-only retries without new announcement sequences, and mixed old/new
  messages. Executed: **14/14 passed** (test DB is an injected route fixture;
  the database uniqueness guarantee was verified by reading the schema).

A daemon sent-log is unnecessary and would not by itself close the crash window
between committing the server message and persisting a local receipt.

## Contract adaptations and upstream risks

- S2 wraps feeds in `{ ok: true, result }` and returns `CURSOR_EXPIRED` inside
  result. Its expiry boundary is `afterSeq + 1 < oldestSeq` (or cursor beyond
  head), rather than the prose contract's `afterSeq < oldestSeq`. S3 consumes the
  actual S2 response without inventing expiry locally. Snapshot task order need
  not be sequence order.
- S2 `AttentionOutbox.snapshot()` scans only retained outbox entries. An unresolved
  task whose last attention entry was evicted is absent from the snapshot. S3
  delivers every supplied snapshot entry, but cannot reconstruct omitted tasks
  through the broker API. This remains an upstream D10 deployment blocker; no
  Runtime files were changed in this stream.
- Broker long-poll waiters remain until their timer fires after a client abort;
  S3 cancels its request immediately. This is existing S2 behavior.
- A durable server row is the delivery acknowledgement, not proof that an agent
  consumed it. The server commits before broadcasting; if it dies between these
  steps, existing session catch-up/reconnect behavior must deliver the row.
  `apiSession.ts` polls for received messages every 5 seconds while connected
  (`startReceivePolling`), in addition to reconnect sync. Actual-agent A08 with
  no Desktop client (GD4, three repetitions) remains
  unexecuted here. No real daemon, credentials, deploy, or push was used.
- Unknown/unowned sessions are skipped rather than adopted by this watcher.
  Ownership recovery remains the existing daemon recovery path's responsibility.
- Larger custom S2 outbox retention must stay within the documented feed/byte
  bounds or add pagination in a coordinated contract change; oversized replies
  fail closed rather than being truncated.

## Verification and handoff

Tests were added and run failing before the corresponding implementations;
Vitest's mandatory build/typecheck reported the missing implementation modules.
The configuration-reader extraction is a separate structural change from the
watcher behavior. Intended commits (each with the requested co-author trailer):

1. `[structural] Share daemon browser broker configuration reader`
2. `[behavioral] Deliver durable browser attention through daemon session messages`

Commit attempt was blocked creating the backing worktree's Git `index.lock`
with `Operation not permitted`. No commit or branch change was performed.
All edits remain exclusively under `packages/happy-cli/src/daemon/` in S3.

Verification commands from `packages/happy-cli`:

```
pnpm typecheck
pnpm exec vitest run --project unit src/daemon/browserAttentionWatcher.test.ts src/daemon/browserAttentionDelivery.test.ts src/daemon/browserTaskBroker.test.ts src/browserRuntime/attention.test.ts src/browserRuntime/broker.test.ts
pnpm exec vitest run --project unit --maxWorkers 4
```

The targeted tests cover duplicates, injected before-ack/after-ack crashes,
restart persistence, expired snapshots, bounded ended/unowned skip records,
corruption/malformed inputs, capped/reset backoff, both message encryption
variants, acknowledgement validation, live-session checks, startup configuration,
shutdown cancellation, bounded HTTP replies, and the real S2 broker/outbox.

Results on 2026-09-25:

- Happy CLI `pnpm typecheck`: passed (including the final test additions).
- Final targeted five-file run: **32/32 passed**, including the real broker,
  startup/shutdown, and unordered snapshot cases.
- Server `pnpm exec vitest run sources/app/api/routes/v3SessionRoutes.test.ts`:
  14/14 passed.
- Full Happy unit run: **8,227 passed / 208 failed / 33 skipped**, 508 files
  passed / 18 failed / 6 skipped. All S3 tests passed. The suite is not green.
  Observed failures include occupied viewer port 6081, trusted-root rejection of
  macOS `/private/tmp`, process spawning/`ps` denied (`EPERM`), Git template copy
  denied, package-install fixture failures, a setuid-mode assertion, two ACP
  mock-handler failures, and one 30s Runtime approval/cancel race timeout.
  These files were not changed; no baseline run was performed, so this is not
  a claim that every failure is confirmed pre-existing.
- `git diff --check`: passed.

- Isolated Runtime race rerun:
  `pnpm exec vitest run --project unit src/browserRuntime/runtime.test.ts -t 'never dispatches an approved action after a concurrent cancel ACK across 50 races'`
  passed (1 selected test, 50 races, 25.45s; 64 unselected tests skipped).
  This is consistent with load sensitivity in the full-suite timeout, not a
  change to the Runtime implementation or its timeout.

Resume: first resolve the worktree Git metadata write restriction, then commit
`browserTaskBroker.ts` as the structural extraction and the remaining daemon
files as the behavioral change. Both commit messages must end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Coordinate the snapshot completeness fix with S2 and run GD4/A08 on the isolated
execution machine before considering S3 deployment acceptance complete. The
broader unit failures remain reported above; no unrelated fixes were made.
