# Sync performance

`Tests/HappyCoreTests/SyncPerfTests.swift` uses fixed keys, nonces, timestamps
and records, an in-memory SQLite store and fake HTTP. It never uses the network.
Elapsed values below are debug medians on the shared Linux build machine;
operation counts are the stable regression guard. Commit counts count
transactions which actually changed a row, rather than empty SQL transactions.

## Reproduce

From `packages/happy-ios`, with Swift 6 and the system SQLite development
headers installed on Linux:

```sh
swift test --build-system native --disable-build-manifest-caching
swift test --build-system native --disable-build-manifest-caching --filter SyncPerf
```

The second command runs the fixed decrypt/merge/2000-message reducer fixtures,
shared SQL observations, presence actors and production `SyncEngine` catch-up
paths. Narrow a run with `--filter SyncPerfTests` for the seven-run medians,
`--filter 'SyncPerfBatchTests|SyncPerfSessionBatchTests'` for batch budgets and
held-HTTP publication, or `--filter 'SyncPerfPresenceTests|SyncPerfObservationTests'`
for presence counts and account lifecycle. `SyncPerfNewSessionTests` covers
background picker projection, ordering and stale replies. The `SYNC_PERF`
stdout lines report elapsed values and exact counters; assertions verify
modifying commits, SQL fetches and feed publications, rather than UIKit calls.

With xtool's Darwin SDK installed, compile the device and simulator targets:

```sh
swift build --build-system native --swift-sdk arm64-apple-ios --disable-build-manifest-caching
swift build --build-system native --swift-sdk arm64-apple-ios-simulator --build-tests --disable-build-manifest-caching
```

If SwiftPM cannot locate the installed SDK, add `--swift-sdks-path /path/to/sdks`.
Linux compiles simulator tests but cannot run them. Run `HappyUIKitTests` on an
Xcode simulator to measure actual applies. Disabling manifest caching avoids
stale target selections when alternating Linux and Darwin builds.

Elapsed heartbeat intervals use an injected clock: 15 two-second ticks over
ten sessions mean 150 total events over a simulated 30 seconds. Tests never
wait 30 real seconds. Exact batch-count fixtures hold the injected deadline
so host scheduling cannot split an otherwise complete fixture. Separate
held-response tests exercise the real 400ms deadline while HTTP is still
pending. Small inverted waits are included in some elapsed values. Shared
machine debug wall times are context, not device frame or speedup claims.

## Before

Measured before changing observations, merges or presence (2026-10-13):

| Scenario | Median wall time | Modifying commits per run | Home values |
| --- | ---: | ---: | ---: |
| Decode/decrypt update | 0.021 ms | — | — |
| Decode/decrypt 50-session list | 0.865 ms | — | — |
| Merge unchanged update-session | 0.385 ms | 1 | — |
| Merge unchanged 50-session page | 96.57 ms | 1 | — |
| Merge unchanged 1000-session page | 2558.75 ms | 1 | — |
| Reducer append into 2000 messages | 4.349 ms | — | — |
| Store append to chat snapshot (2000 messages) | 4.073 ms | 1 | — |
| 10 sessions, 30s of unchanged 2s heartbeats | 746.9 ms total | 150 | 150 |

The heartbeat benchmark advances an injected clock instead of waiting 30s.
It waits for each home delivery to measure fan-out without hiding it through
observation coalescing. The narrow chat-session projection stays unchanged.

The debug ceiling is deliberately generous (10s for synchronous scenarios,
2s for chat delivery), because other workers compile on the same machine.
No simulator or device is available here; these numbers do not measure UIKit.

## After shared observations, no-op merges, presence and bounded batches

Measured with the same fixed fixtures on 2026-10-13. Values exclude the
initial replay to a subscriber. A publication is a production feed value,
not a UIKit apply; simulator apply times remain unverified.

| Scenario | Modifying commits per run | Feed publications per run |
| --- | ---: | --- |
| Unchanged update-session, 50-session page or 1000-session page | 0 | 0 home |
| 10 sessions × 15 heartbeats at 2s intervals (150 total over 30s) | 0 | 0 home, 0 chat |
| Stop after those 150 session heartbeats | 1 batched checkpoint | 0 home, 0 chat |
| 10 machines × 15 heartbeats (150 total over 30s) | 0 | 0 home, 0 machines |
| Machine heartbeat checkpoint at 61s | 1 | 0 home, 0 machines |
| 500 messages across 10 sessions and 20 HTTP pages | 1 | 0 home, 1 chat for the watched session |
| 1000 encrypted socket messages with 1000 stored sessions | 1000 | 0 home SQL fetches, publications and derivations; scoped Info and Troubleshooting update |
| 500 session rows across 5 HTTP pages, including first-list readiness | 1 | 1 home |
| Seven home subscribers | One shared fetch per invalidation | Each receives the shared value |

Baseline unchanged merges each made **one commit per run**. The seven-run
benchmark's totals were seven commits for each scenario, or 21 across all
three scenarios; after the change those totals are zero. The heartbeat
baseline was **150 total events**, commits and home values across ten
sessions, rather than 150 events per session.

Current shared-machine debug medians: unchanged 50-session merge 11.80ms,
unchanged 1000-session merge 242.51ms, store-to-chat with 2000 existing
messages 3.89ms, and the 500-message catch-up 76.87ms over five runs. The
500-session listing took 377.84ms in one run. Concurrent compilation and
debug builds make wall-time ratios unsuitable as a performance claim.
Exact transaction, fetch and publication counts are the regression guards.

Heartbeats live in one presence actor per account. Online timestamps remain
stable in displayed snapshots, while the actor tracks the newest wire stamp.
Flips persist immediately; otherwise dirty sessions and machines share one
checkpoint about once a minute, on background, or on stop. Active state is
server-authoritative, matching happy-app's storage: the client never invents
a timeout from its wall clock. Tests exercise phone clocks fifteen minutes
ahead and behind, eleven minutes of silence, explicit server offline packets,
stale packets, background/restart and last-seen display granularity.

Session-list and message pulls share a batch primitive with defaults of
1000 records, 4MiB of ciphertext and a 400ms deadline. The independent deadline
flushes completed downloads even while the next HTTP request is held. No
SQLite transaction spans an await. One indivisible row larger than the byte
limit is committed immediately on its own. Count/byte splits retain completed
pages on failure or cancellation; message cursors never advance beyond
persisted records, and full-list deletion/readiness/cursors occur only after
the listing completes. Tests hold the next HTTP response and verify the
first production feed publication arrives before releasing it.

The shared home producer still fetches and compares an O(N) snapshot after a
meaningful home-region change or coarse presence checkpoint. It performs
that work off main once per account, rather than once per screen. This is a
remaining producer cost, separate from the minimal UIKit changesets.

Presence flips publish from the post-checkpoint database observation. An
explicit projection of an older cached raw row could otherwise expose the
wrong unread state between busy and idle. One captured clock value is set
synchronously before the checkpoint; async refreshes only project the latest
overlay. The busy/idle/read fixture asserts three modifying commits, three
new home values, and four home SQL fetches including the initial value.
An advancing clock verifies one value each for session offline, machine
offline and a last-seen tick. Those tests and account stop/restart each passed
50 repeated isolated runs. Account stop drains both active and retiring hub
tasks; producer generations reject late callbacks from an older scope.

Shared GRDB callbacks queue value and error delivery before resuming an
async consumer. GRDB holds its shared client lock while invoking callbacks;
direct continuation delivery there can deadlock with the consumer's
synchronous cancellation handler. One serial bridge per subscription breaks
that lock cycle without changing shared SQL fetching, cached replay or
synchronous client cancellation. One pending latest snapshot and one
terminal error keep each delivery mailbox bounded. Held-callback regressions
cover Home values and errors, and the direct Settings stream. The original five-second restart
deadline, seven-subscriber single fetch, fresh account-stop disk read and
observation-error recovery checks remain in place.

Wire deletion and full-list reconciliation prune cached presence and dirty
ids. Store overlays discard only deleted rows; reconciliation reads retained
ids without decoding JSON, preserving socket rows newer than a list cutoff.
Tests verify deleted ids produce no phantom last-seen ticks and an id
reintroduced with a lower stamp starts from its current stored row.

New-session picker catalogs, choice derivation and equality run on a dedicated
actor. The UI receives a choice revision and installs the prepared value.
Session place/workspace fields, machine choice inputs, project names and
agent defaults drive that revision; unread, message cursors, title, profile
and the presence display clock do not. A 1000-session fixture asserts zero
picker rebuilds and zero change callbacks for those unrelated fields, then
one rebuild and callback for a changed path. Draft text edits reuse the
catalog, and generation guards discard a held bootstrap after a newer pick.
Bot names and faces still notify their views immediately, and draft
corrections retain the existing four-pass bound.

Picker order follows happy-app's `useSessions`: active chats first, then
`lastMeaningfulMessageAt`, this device's last accepted send, or creation
time, with a stable id tie-breaker.
Side chats are excluded. Updating `updatedAt` or reversing the raw SQL order
does not rebuild pickers; meaningful activity and active-state changes do.

Troubleshooting has its own atomic SQL snapshot: only computer-grouping
metadata and the newest known-computer session's project/path/log-directory
fields are decoded. One account-owned projection shares the computer list
and prompt, caching computer grouping until those inputs change. A fixture
with 1000 sessions and seven subscribers asserts one SQL fetch and one
computer derivation. A real live message changes the recent project without
regrouping computers; equal prompts and unrendered machine fields publish
nothing. Machine deletion selects the next known session in the same value,
and presence/account lifecycle tests cover server flags and fresh scopes.
Session info and troubleshooting now use their scoped feeds, so Home no
longer watches `updatedAt`. The encrypted socket fixture runs the production
decode/store path and actual Home derivation, checks Info's sequence and
last-updated row changes and Troubleshooting's recent project, and verifies
all 1000 chat messages decrypt and advance the contiguous cursor. A subsequent
settings change adds exactly one Home fetch, publication and derivation.
The unused generic main-actor SQL observation API has been removed; its two
atomic composer tests now fetch with GRDB's background scheduling.

The local send timestamp lives in a nullable SQLite session column, added
by migration v4. Acceptance stores the text, files and timestamp atomically,
so it works offline and survives reopen. A refused send, standalone store
file item, retry or echoed localId never advances it. A picture-only send
accepted through the production send path does advance it. Wire merges preserve it, and
agent-published meaningful activity always wins. The Home region explicitly
watches this column; the chat header projection clears it. Tests cover v3
migration, reopen, wire preservation, duplicate acceptance with zero writes,
echo replay, real offline acceptance and activity ordering.

`HappyStore.ThreadRules` checks synchronous store reads/writes, migration,
sync work and reducer entry points in debug builds. Its enforcement flag
remains disabled until integration finishes migrating every screen caller.
Tests enable a recording handler to prove main store access is caught and
background sync, reducer and picker work produces no violations.