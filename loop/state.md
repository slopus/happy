# Loop State

Last updated: 2026-03-22 17:37

## Current Task

TASK: Level 2 — get the remaining Claude exercise-flow steps passing on the real daemon/CLI stack

## Why This Task

The Step 3+ Claude permission-path stabilization is now complete on the real
stack. A real Vitest run on March 22, 2026 proved:
- Step 0: pass (1.1s)
- Step 1: pass (32.1s)
- Step 2: pass (5.6s)
- Step 3: pass (12.6s)
- Step 4: pass (13.1s)
- Step 5: pass (12.6s)
- Step 6: pass (5.1s)

The next gap is broader Claude Level 2 coverage: Steps 7-34 are still
unproven on the real server → daemon → CLI → SyncNode path.

## Completed Tasks

- [x] Rename happy-wire → happy-sync, update all imports
- [x] Build SyncNode class (transport, encryption, state, outbox, pagination)
- [x] Level 0 unit tests passing (protocol schemas, mappers, SyncNode state)
- [x] Level 1 integration tests passing (20/20, auto-boots server)
- [x] Delete happy-agent package
- [x] Delete happy-wire package
- [x] Wire CLI imports to happy-sync
- [x] Remove legacy message processing from app
- [x] Clean up as-any casts at boundaries
- [x] Fix e2e test infrastructure — auto-boot server + real daemon
  - Created `e2e/setup.ts`: boots standalone PGlite server + real daemon binary
  - Pre-seeds daemon credentials (shared secret with test SyncNode)
  - Daemon spawns real CLI processes via `/spawn-session` HTTP endpoint
  - Removed all env var skip conditions (ANTHROPIC_API_KEY, CODEX_AVAILABLE, OPENCODE_AVAILABLE)
  - Updated all 3 e2e test files (claude, codex, opencode) to use daemon spawning
  - Fixed `waitForStepFinish` to skip intermediate tool-call turns
  - Verified Steps 0-2 pass with real Claude:
    - Step 0: Session spawned via daemon (1.1s) ✓
    - Step 1: Claude reads files and describes project (29s) ✓
    - Step 2: Claude finds the bug in Done filter (3.5s) ✓
- [x] Publish real Claude partial / permission state through SyncNode
  - `packages/happy-cli/src/claude/session.ts` now patches the in-flight
    assistant message via `SyncBridge.updateMessage()`
  - Permission transitions are queued and replayed if the permission callback
    fires before the tool part exists in the Claude v3 mapper
- [x] Fix batched message patch semantics on the server
  - `packages/happy-server/sources/app/api/routes/v3SessionRoutes.ts` now keeps
    the latest payload for duplicate `localId`s in the same POST batch
- [x] Stabilize real Claude Step 3+ in Vitest after permission-path fixes
  - `packages/happy-sync/src/e2e/claude.integration.test.ts` now uses the exact
    exercise-flow rejection follow-up for Step 3 (`Fix it.` → reject → `No —
    show me the diff first.`)
  - Step 5 now waits for the approved write tool tied to the permission call to
    reach `completed`, and asserts the durable `decision` part plus resolved
    tool block carry `decision: 'always'`
  - Step 6 now waits for a completed write tool or a fresh permission request,
    so the test proves auto-approval structurally instead of hanging on a final
    prose turn
  - Real proof on March 22, 2026:
    `npx vitest run src/e2e/claude.integration.test.ts --testNamePattern='Step [0-6] —' --reporter=verbose`
    → `7 passed | 33 skipped`, file passed in 87.56s

## Remaining Tasks (in priority order)

1. Level 2: Get all 34 steps passing for Claude (current)
   - Steps 0-6 are now green on the real daemon path
   - Remaining work is Steps 7-34 and the cross-cutting assertions
2. Level 2: Codex variant
3. Level 3: Browser/UX verification
4. Final dead code cleanup

## Blocked / Investigated

- Direct probe success: with the real server, real daemon, and real Claude CLI,
  a manual reproduction of Steps 0-3 produced a blocked `Edit` tool plus an
  unresolved permission request in the root session within 45s. So the real
  permission bridge is working after the runtime fixes.
- Real Vitest proof on March 22, 2026:
  `npx vitest run src/e2e/claude.integration.test.ts --testNamePattern='Step [0-6] —' --reporter=verbose`
  passed with `7 passed | 33 skipped` in 87.56s. Step 3-6 are no longer flaky
  after the exercise-flow prompt fix plus structural Step 5/6 waits.
- One concrete bug was fixed during this investigation: batched POSTs with the
  same `localId` used to keep the FIRST payload in the batch, which dropped
  newer assistant/tool-state patches. That regression caused stale running tool
  state and broke Step 1 until the route was changed to last-write-wins.
- Multi-turn message flow: Claude sends separate assistant messages for each
  LLM turn (step-start + tools + step-finish). The final message has the text.
  This means tool assertions need to check across ALL new assistant messages,
  not just the last one.
- Step 5/6 root cause: the test was waiting for a final non-`tool-calls` turn,
  but the real Claude flow already satisfied the spec once the write tool had
  reached `completed`. Structural tool waits are required here.
- Important state-model nuance: `session().permissions` only contains CURRENTLY
  blocked requests. Once a permission is approved and the tool completes, the
  durable evidence lives in the decision part / resolved tool block, not in
  `session().permissions`.

## Anti-patterns (DO NOT DO THESE)

- DO NOT run unit tests and declare "all tests pass" when integration tests are skipped
- DO NOT say "needs infrastructure" without investigating WHY and attempting to fix it
- DO NOT clean up types, remove as-any, or do cosmetic work while e2e tests don't run
- DO NOT declare acceptance criteria "done" based on code existing — it's done when TESTS PROVE IT
- Skipped tests are FAILURES, not successes
