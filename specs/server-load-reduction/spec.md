# Bound idle receive polling

2026-09-28 user requested server-load improvements, Claude Opus 5.5/high review, corrections, commits and PRs. Release/tag/publish is not part of this change.

## Requirements and tradeoff
Preserve socket fast-path, durable cursor/deduplication, reconnect catch-up, and timer cleanup. Reduce empty receive GETs with exponential delay capped at 30 seconds. First connected poll still runs after 5 seconds. A missed socket message during prolonged idle is recovered within 30 seconds plus transport duration, versus the prior 5-second polling cadence. Socket message traffic resets the delay. This explicitly supersedes the fixed 5-second cadence described by platform specs/session-message-receive-poll/plan.md, retaining its no-permanent-message-loss requirement.

Choose a wire-compatible client change instead of introducing a machine-wide polling protocol. Test empty request count, persisted missed-message delivery, cursor/dedupe and close/reconnect. Do not update the consuming platform submodule pointer or Desktop runtime pin before a separate CI-published CLI release.

## Plan and state
1. Add idle bound/recovery regression: observed 13 message reads in one idle minute before the change (done).
2. Implement bounded idle delay at existing receive loop (done).
3. Targeted ApiSession suite plus build: 138 tests passed on latest main 50cca826; existing build warnings recorded.
4. Claude Opus 5.5/high review PASS after replacing wall-clock deadlines with 5s tick countdown and adding steady-state cap, clock rollback and live-socket reset regressions. PR: https://github.com/buzzni/happy/pull/588.

## Rollout
After merge, use the existing explicit-approval GitHub Actions release runbook. Roll back via previous released runtime pin. Validate empty GETs per connected session, missed-event recovery, receive lag and reconnect behavior before broad rollout. No production reduction is claimed by unit tests.

The 30s bound is the scheduled poll gap, excluding event-loop stalls and transport time. Latest main shutdownReceiveSeq guards remain intact. Re-review used the final /tmp/saycode-happy-load-review branch, not the platform pinned submodule checkout.
