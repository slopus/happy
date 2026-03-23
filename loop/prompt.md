# Agent Loop Prompt

You are working on the happy-sync refactor. The full spec is in
docs/plans/happy-sync-major-refactor.md — read it for context, but your
IMMEDIATE task comes from `loop/state.md`.

## Workflow

1. Read `loop/state.md` — this is your task assignment
2. Read `loop/learnings.md` — hard-won knowledge from previous iterations
3. Read `docs/plans/happy-sync-major-refactor.md` for context on the overall design
4. Do the CURRENT TASK described in state.md. Nothing else.
5. When done (or blocked), update `loop/state.md`:
   - Move completed items to "Completed Tasks"
   - Update "Current Task" to the next priority item
   - Add any blockers or findings to "Blocked / Investigated"
   - Update "Last updated" timestamp
6. If you discover something non-obvious (a subtle bug, a surprising behavior,
   a technique that worked), append it to `loop/learnings.md`

## Rules

### Testing is non-negotiable

- Run the ACTUAL tests that prove your work. Not unit tests — the integration/e2e tests.
- If tests are SKIPPED, that is a FAILURE. Investigate WHY they skip and fix it.
- `describe.skip` / `it.skip` / conditional skipping via env vars = your code is not tested.
- Before declaring anything done, show the test output proving it works.

### No busywork

- DO NOT clean up types, fix linting, remove `as any`, rename variables, add comments,
  or do ANY cosmetic work unless the current task specifically requires it.
- DO NOT run unit tests and declare victory. Unit tests with mocks prove nothing about
  integration. The spec says "All four testing levels pass."
- The hard problems are: wiring real CLIs through SyncNode, making the daemon spawn
  sessions, getting e2e tests to actually execute against real processes.

### Environment

- The CLIs (`claude`, `codex`) are ALREADY installed and authenticated on this machine.
  They do NOT need ANTHROPIC_API_KEY or OPENAI_API_KEY env vars — they have their own
  built-in auth. If a test skips because of missing API key env vars, that skip
  condition is WRONG and must be removed/fixed.
- The server can be auto-booted — see how Level 1 tests do it in
  `packages/happy-sync/src/sync-node.integration.test.ts` (spawns standalone server
  with PGlite, creates auth tokens automatically).
- The e2e tests MUST boot the REAL happy daemon (real build from packages/happy-cli).
  The daemon is what spawns CLI processes when sessions are created. DO NOT spawn
  CLIs directly from the test — that bypasses the daemon and doesn't test the real flow.
- The production flow is: server → daemon → daemon spawns CLI on new session →
  CLI connects its own SyncNode → messages flow. The test must exercise this EXACT flow.
- Look at `packages/happy-cli/src/daemon/run.ts` for how the daemon works.
- DO NOT add env var skip conditions. DO NOT require manual setup. Tests must be
  self-contained: boot server, boot real daemon, create session via SyncNode,
  daemon spawns CLI, messages flow through SyncNode.

### State management

- `loop/state.md` is the source of truth for progress. READ IT FIRST.
- `loop/learnings.md` is accumulated knowledge. Read it before working, append to it when you learn something.
- Update state when you finish or get blocked. Be honest about what works and what doesn't.
- If you find the previous agent's work is broken, say so and explain why.
- Before editing files, run `git diff --stat HEAD` to see what the previous iteration changed.

### Focus

- One task at a time. Finish it or document why you're blocked before moving on.
- If the current task is too big, break it into subtasks in the state file.
- Do not start a new task until the current one is proven done with passing tests.
