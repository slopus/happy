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

### Simplification pass after every task

After completing each task (and ONLY after tests prove it works), do a quick
simplification pass on the code you touched:

- **Look for duplication.** The v3Mapper files (claude, codex, gemini, openclaw) are
  ~2100 lines total and share massive structural overlap. Can shared logic be extracted?
- **Question every new file and abstraction.** Is it pulling its weight? Could it be
  inlined or merged?
- **Check line counts.** Run `git diff main --stat` on the files you changed. If a file
  grew significantly, ask: is this complexity necessary, or did I copy-paste when I
  should have reused?
- **Delete dead code aggressively.** If migration made something unused, remove it now
  rather than leaving it for a cleanup task.
- **Don't gold-plate.** This is a 5-minute check, not a refactoring project. If you spot
  a big simplification opportunity, note it in `loop/state.md` under a "Simplification
  opportunities" section and move on. Small wins (extract a shared helper, delete dead
  code) — just do them.

### SDK-first approach

Each agent integration should use the OFFICIAL TYPED SDK, not hand-rolled protocol code:

- **Claude**: `@anthropic-ai/claude-code` — already in use
- **Codex**: `@openai/codex-sdk` — MUST migrate to this. The current
  `codexAppServerClient.ts` is a manual JSON-RPC client. Replace its internals with
  SDK calls. This gives us full TypeScript types and automatic protocol compat.
  Install: `yarn add @openai/codex-sdk` in happy-cli.
- **OpenCode/ACP**: `@agentclientprotocol/sdk` — already in use via `AcpBackend.ts`.
  The ACP adapter (`packages/happy-cli/src/agent/acp/`) and openclaw adapter
  (`packages/happy-cli/src/openclaw/`) are ALREADY FUNCTIONAL. When working on the
  OpenCode e2e variant, lean on what's there — don't rewrite from scratch.

The SyncBridge/v3Mapper layer is OUR protocol (happy-sync ↔ server). Keep it.
The SDKs handle the agent ↔ happy-cli communication underneath.

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

### Commit progress regularly

- **Commit after every completed task** (or meaningful milestone). Do NOT let
  work accumulate across many iterations without committing. Uncommitted work
  is at risk of being lost.
- Use descriptive commit messages: `checkpoint: OpenCode Steps 0-13 passing`
- You can commit partial progress too — `wip: OpenCode e2e Steps 0-6 pass, 7+ in progress`

### CRITICAL: Do NOT kill the global daemon or user sessions

- The human is actively using the happy daemon and happy sessions on this machine.
  **NEVER kill, restart, or send signals to the global daemon or any sessions you
  did not spawn.** Doing so destroys the human's active work.
- The daemon restart logic (`daemon start-sync`, version mismatch detection) will
  SIGTERM the global daemon if triggered. Your tests MUST NOT trigger this.
- Tests must spawn their OWN isolated daemon instance (e.g. on a different port,
  with a different state directory) — never interact with the global one.
- If your test code calls `daemon start-sync` or any daemon control function that
  could restart the global daemon, that is a **critical bug**. Fix it.

### Clean up orphan processes

- After running e2e tests, check for orphan agent processes that YOUR TESTS spawned.
- **ONLY clean up processes spawned by your test runs** (look for processes with
  temp directory paths or test-specific ports).
- **DO NOT kill**: the global daemon, any user-started happy sessions, the loop
  process itself (`loop/run.sh`), or any process not started by the tests.
- When in doubt, leave a process alone. It's better to leak a test process than
  to kill the human's active session.

### STOP — READ THIS BEFORE TOUCHING ANY TEST FILES

There are TWO phases to the browser work. You MUST complete Phase 1 before
starting Phase 2.

**THE PREVIOUS PHASE 1 ATTEMPT WAS REJECTED** because it only covered 3 out
of 34 steps and was declared "done". That is NOT acceptable. Phase 1 means
ALL 34 STEPS walked through manually. Not 3. Not 10. ALL 34.

If you skip Phase 1 and start writing Playwright tests or editing
`browser.integration.test.ts`, you are doing it WRONG. Stop and go back
to Phase 1.

DO NOT edit any test file (*.test.ts) until Phase 1 is COMPLETE with ALL 34
steps recorded in `loop/state.md`.

### Phase 1: Manual browser walkthrough — ALL 34 STEPS (DO THIS FIRST)

`agent-browser` is a CLI tool. Run it via Bash like any other CLI:
```bash
npx @anthropic-ai/agent-browser
```

Use it to manually control a real Chrome browser. The workflow is:

1. Boot infrastructure (server + daemon) programmatically using the existing
   e2e setup helpers (same as the existing tests do)
2. Start the Expo web dev server with `BROWSER=none` (prevents auto-open)
3. Use `agent-browser` to open the web app URL in Chrome
4. Spawn a real Claude session via SyncNode
5. Run ALL 34 exercise steps. For EACH step:
   a. Send the step's prompt via SyncNode
   b. Wait for Claude to respond (handle permissions, questions, etc.)
   c. Switch to agent-browser and LOOK at the rendered page
   d. Take a screenshot
   e. Note what rendered: tools, permissions, text, errors
6. AFTER all 34 steps, test these EXTENDED scenarios:
   - Create a SECOND session (different agent), switch between them
   - Send a message to Session B while viewing Session A, verify isolation
   - Close the browser tab, reopen it — does the session restore?
   - Reopen the completed/stopped session — transcript still there?
   - Navigate away from session page, come back
   - Session list: both sessions show with correct metadata?

Record EVERYTHING in `loop/state.md` under "## Phase 1 Results (Full 34 Steps)".
For EACH step: step number, what rendered, any issues.
Screenshots required at minimum: step 1, step 3 (deny), step 4 (approve),
step 10 (cancel), step 12 (question), step 20 (close), step 34 (summary),
session switching, tab close/reopen.

**Phase 1 acceptance criteria:**
- ALL 34 steps walked through and documented (check: count the step entries)
- Extended scenarios tested and documented
- Any bugs found are FIXED
- If you have fewer than 34 step entries in your results, YOU ARE NOT DONE

### Phase 2: Write the automated e2e test (ONLY after ALL 34 steps recorded)

ONLY start this after `loop/state.md` has a "Phase 1 Results (Full 34 Steps)"
section with entries for ALL 34 steps from the manual walkthrough.

Write the Playwright e2e test covering everything you verified manually:
- **Claude**: full 34-step exercise flow rendered in browser (primary agent,
  FULL COVERAGE — this is the core path, do not skip steps)
- **Other agents (Codex, OpenCode)**: lightweight — just prove starting a
  session works, send one message, verify render + response. No full 34 steps.
- **Multi-session / navigation**: switch between Claude + other-agent sessions,
  verify independent transcripts, send to Session B while viewing A, close tab
  and reopen, navigate away and back, reopen completed sessions, session list.
- **Video recording**: EVERY browser test MUST record video via Playwright:
  ```typescript
  const context = await browser.newContext({
    recordVideo: { dir: 'e2e-recordings/', size: { width: 1280, height: 720 } }
  });
  ```

### Environment: prevent Expo auto-opening browser

ALWAYS set `BROWSER=none` before starting Expo web dev server. This prevents Expo
from popping up browser windows on the human's machine. You control the browser
via agent-browser or Playwright — Expo should NOT open anything.

### Focus

- One task at a time. Finish it or document why you're blocked before moving on.
- If the current task is too big, break it into subtasks in the state file.
- Do not start a new task until the current one is proven done with passing tests.
