# Agent Loop Prompt

You are working on the happy-sync refactor. The full spec is in
docs/plans/happy-sync-major-refactor.md — read it for context, but your
IMMEDIATE task comes from `loop/state.md`.

## Workflow

1. **FIRST: check for uncommitted work.** Run `git status` and `git diff --stat HEAD`.
   If there are uncommitted changes from a previous iteration, COMMIT THEM NOW
   with a descriptive message before doing anything else. Do not lose work.
2. Read `loop/state.md` — this is your task assignment
3. Read `loop/learnings.md` — hard-won knowledge from previous iterations
4. Read `docs/plans/happy-sync-major-refactor.md` for context on the overall design
5. Do the CURRENT TASK described in state.md. Nothing else.
6. **COMMIT your work** before finishing. Every iteration must end with a commit.
   Use descriptive messages: `checkpoint: Phase 1 steps 1-10 visual walkthrough`
7. When done (or blocked), update `loop/state.md`:
   - Move completed items to "Completed Tasks"
   - Update "Current Task" to the next priority item
   - Add any blockers or findings to "Blocked / Investigated"
   - Update "Last updated" timestamp
8. If you discover something non-obvious (a subtle bug, a surprising behavior,
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

**PHASE 1 HAS BEEN REJECTED TWICE.** Read `loop/state.md` Current Task carefully.

- First rejection: only 3 steps
- Second rejection: 34 steps but NO visual verification — ran programmatically
  without ever looking at the browser

The ENTIRE POINT is to use `agent-browser` to SEE the rendered UI components
and take screenshots proving each one looks correct. If you're not using
agent-browser to look at the page and screenshot it, you're doing it wrong.

DO NOT edit any *.test.ts file until Phase 1 is complete with ALL steps
recorded AND all component types checked off in `loop/state.md`.

### Phase 1: VISUAL browser walkthrough — ALL 38 STEPS

`agent-browser` is a CLI tool. Run it via Bash:
```bash
npx @anthropic-ai/agent-browser
```

Use it to control a real Chrome browser and LOOK at the Happy web app.

1. Boot infrastructure (server + daemon + Expo web with BROWSER=none)
2. Use `agent-browser` to open Chrome, navigate to the web app
3. Spawn a real Claude session via SyncNode
4. Run ALL 34 exercise steps PLUS 3 new steps (35-37, see state.md).
   For EACH step:
   a. Send the prompt via SyncNode
   b. Wait for Claude to respond
   c. Use agent-browser to LOOK at the page and TAKE A SCREENSHOT
   d. Record what components rendered and how they look
5. After all steps, test extended scenarios (session switching, close/reopen, etc.)

**The goal is visual component coverage.** You need a screenshot proving each
component type renders correctly: user messages, assistant text, every tool type,
permissions (blocked/approved/denied), subagents with nested tools, questions,
todos, background tasks (running + completed), TaskCreate/TaskOutput, cancelled
steps, session list, empty session, completed session. See the full checklist
in `loop/state.md`.

**Phase 1 acceptance:**
- ALL 38 steps with agent-browser screenshots
- ALL component types checked off with screenshots
- Extended scenarios tested
- Fewer than 38 step entries = NOT DONE

### Phase 1.5: UX consistency review by Codex + Gemini (after Phase 1)

After Phase 1 screenshots + video are captured:

1. Collect ALL screenshots into one directory (e.g. `/tmp/happy-ux-review/`)
2. Call `codex` CLI and `gemini` CLI, giving each the FULL set of screenshots
   and asking for a thorough UX consistency review (see state.md for the exact
   review prompt). They must see ALL artifacts at once to judge consistency.
3. Compare both reviews, record in state.md under "## UX Review Results"
4. Fix any real inconsistencies before Phase 2

The goal is NOT to redesign — Happy already represents tool calls well. The
goal is to verify the refactor didn't break visual quality or introduce
regressions. Flag only real issues, not style preferences.

### Phase 2: Automated e2e test (ONLY after Phase 1 + 1.5)

ONLY after Phase 1 results (all 38 steps) AND Phase 1.5 UX review are done.

Write the Playwright e2e test:
- **Claude**: full 38-step flow in browser (primary agent, full coverage)
- **Other agents**: lightweight — start session, send one message, verify render
- **Multi-session / navigation**: switching, isolation, close/reopen, session list
- **Video recording**: every test records video via Playwright

### Environment: prevent Expo auto-opening browser

ALWAYS set `BROWSER=none` before starting Expo web dev server. This prevents Expo
from popping up browser windows on the human's machine. You control the browser
via agent-browser or Playwright — Expo should NOT open anything.

### Focus

- One task at a time. Finish it or document why you're blocked before moving on.
- If the current task is too big, break it into subtasks in the state file.
- Do not start a new task until the current one is proven done with passing tests.
