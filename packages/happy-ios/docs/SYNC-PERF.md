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