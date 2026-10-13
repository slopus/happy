# Sync performance

`Tests/HappyCoreTests/SyncPerfTests.swift` uses fixed keys, nonces, timestamps
and records, an in-memory SQLite store and fake HTTP. It never uses the network.
Elapsed values below are debug medians on the shared Linux build machine;
operation counts are the stable regression guard. Commit counts count
transactions which actually changed a row, rather than empty SQL transactions.

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