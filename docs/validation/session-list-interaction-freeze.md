# Mobile session list startup responsiveness

Scope: mobile initialization and session sidebar action lifecycle.
Status: code and automated regressions verified; affected-device cold launch pending.

## Behavior and implementation

Native history reconciliation previously fetched up to four sessions concurrently
but committed every response through a separate snapshot writer. Each writer
rebuilt session list projections and read/serialized the complete warm cache.
Single-row calls also bypassed the writer's between-batch task yields.

Reconciliation now fetches and commits groups of at most four sessions, with an
explicit task yield between groups. It preserves the HTTP concurrency limit while
reducing list/cache work. For 150 cached sessions, the regression fixtures require
at most 38 whole-cache parses and writes, versus 150 before, and process queued
input before reconciliation finishes. Both a changes-supported server and the
legacy endpoint fallback are covered.

- Snapshot writers capture deletion generations before HTTP starts; late responses
  cannot resurrect a deleted session or its warm-cache snapshot.
- Account changes stop remaining old-owner batches.
- Individual failures do not starve later healthy sessions. The cursor stays put
  until the entire operation succeeds, so another connection/user signal can retry.
- A wholly rejected network batch stops further requests. No periodic polling is
  introduced.

Session action controllers initialize on first menu use and remain mounted while
hidden. Reopening a menu preserves the real useHappyAction in-flight guard;
completed actions can be invoked again. Closed, never-used phone menus initialize
no action hooks. Desktop inline actions retain their state across hover changes.

Message decoding/decryption is bounded to groups of 16 on all platforms, with task
yields after the first group and as additional work budgets are consumed. Native
warm-cache restoration reuses the snapshot writer's bounded batches instead of
publishing one session at a time. These are separate bounded-work improvements:
warm restoration completes before the sidebar mounts and is not established as
the cause of a visible sidebar stall.

No additional drawer/context behavior is shipped. Full nested React Navigation
coverage confirms that parent focus propagation closes the existing drawer.

## Verification

Local validation before PR creation:

- 15 targeted Vitest files / 473 tests passed.
- happy-app TypeScript check passed.
- git diff --check passed.
- The menu reopen regression and the two native reconciliation input-budget
  regressions failed before their fixes.
- Coverage includes partial failure/retry, total network failure, deletion races,
  account switching, warm-cache corruption, crypto cache semantics, message
  visibility and full navigation focus propagation.

The scheduling fixtures use local codecs and immediately resolving HTTP fixtures.
They establish task scheduling, state and persistence behavior, not phone latency.
No native dependency, package, OTA channel or runtime contract changed. Native
rebuilds are not required by these source changes.

## Device acceptance still required

Cold-launch the updated mobile app with the affected account, immediately open the
sidebar, select completed/running sessions and open/close their action menus.
Record input latency and any remaining post-render sync/render work. A green CI or
published OTA does not establish that the original device symptom is resolved.
