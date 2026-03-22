# Loop State

Last updated: (not yet started)

## Current Task

TASK: Fix e2e test infrastructure so Level 2 tests actually run

## Why This Task

The Level 2 e2e tests (packages/happy-sync/src/e2e/*.integration.test.ts) have
NEVER actually run. They are silently skipped and structurally broken:

1. The tests check for env vars like `ANTHROPIC_API_KEY` and skip if missing — but
   this is WRONG. The `claude` and `codex` CLIs are already installed and authenticated
   on this machine. They don't need API key env vars — they have their own auth.
2. The tests call `node.sendMessage()` to send a user message but NO CLI process
   exists on the other end to respond. Nothing spawns a Claude/Codex process when
   a session is created. The test sends messages into the void.

The REAL architecture (per the spec) is:
  test SyncNode creates session → server notifies daemon → daemon spawns CLI →
  CLI connects its own SyncNode → test sends user message → CLI responds →
  response flows back through SyncNode to the test

This means the e2e test must boot the REAL happy daemon (a real build, not a mock),
which listens for new sessions and spawns real CLI processes. This is EXACTLY what
happens in production. The test is:
  1. Boot server (like Level 1 does — standalone with PGlite)
  2. Boot the REAL happy daemon (built from packages/happy-cli, pointing at that server)
  3. Test creates a session via SyncNode
  4. Daemon detects new session, spawns real `claude` or `codex` CLI
  5. Test sends user messages via SyncNode
  6. CLI processes them, responses flow back through SyncNode
  7. Test reads `syncNode.state` and asserts

The Level 1 integration tests (sync-node.integration.test.ts) already auto-boot
a server. The e2e tests need that PLUS a real daemon process.

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

## Remaining Tasks (in priority order)

1. Fix e2e test infrastructure (current)
   - Remove ANTHROPIC_API_KEY / env var skip conditions (CLIs are already authed)
   - Make e2e tests auto-boot server (like Level 1 does — standalone with PGlite)
   - Boot the REAL happy daemon (real build from packages/happy-cli) pointing at
     that server. The daemon must be the one that spawns CLIs — not the test directly.
   - The flow: boot server → boot daemon → test creates session via SyncNode →
     daemon detects session and spawns real CLI → test sends user message →
     CLI responds through SyncNode → test asserts on syncNode.state
   - This is the EXACT production flow. No shortcuts, no test-only CLI spawning.
   - Verify at least Step 0-2 of exercise flow pass with real Claude
2. Level 2: Get all 34 steps passing for Claude
3. Level 2: Codex variant
4. Level 3: Browser/UX verification
5. Final dead code cleanup

## Blocked / Investigated

- E2e tests structurally broken — send messages but no CLI process exists to respond
- The `claude` and `codex` CLIs are already installed and authenticated. They do NOT
  need ANTHROPIC_API_KEY or OPENAI_API_KEY env vars. Remove those skip conditions.
- The e2e test must boot the REAL daemon which spawns CLIs. Do NOT spawn CLIs
  directly from the test — that bypasses the daemon and doesn't test the real flow.
- Look at packages/happy-cli/src/daemon/run.ts for how the daemon works.
  Look at how it detects new sessions and spawns CLI processes.

## Anti-patterns (DO NOT DO THESE)

- DO NOT run unit tests and declare "all tests pass" when integration tests are skipped
- DO NOT say "needs infrastructure" without investigating WHY and attempting to fix it
- DO NOT clean up types, remove as-any, or do cosmetic work while e2e tests don't run
- DO NOT declare acceptance criteria "done" based on code existing — it's done when TESTS PROVE IT
- Skipped tests are FAILURES, not successes
