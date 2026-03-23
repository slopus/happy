# Loop Learnings

Hard-won knowledge from 37+ loop iterations. READ THIS BEFORE STARTING WORK.
If you discover something non-obvious, append it here under the right section.

## Testing

- `waitForStepFinish` alone is not enough — Claude sends multiple assistant
  messages per LLM turn (step-start + tools + step-finish). Tool assertions
  must check across ALL new assistant messages, not just the last one.
- Step-finish with reason `tool-calls` is an intermediate turn, not a terminal
  one. Wait for a step-finish with a non-`tool-calls` reason, or for the tool
  to reach a terminal status (`completed` / `error`).
- `session().permissions` only contains CURRENTLY blocked requests. Once
  approved and completed, the evidence lives in the decision part / resolved
  tool block, not in `session().permissions`.
- The e2e tests take 10-30s per step. A full Steps 0-6 run takes ~90s.
  Budget your time — don't try to run all 34 steps in one go if you're
  debugging a specific failure. Use `--testNamePattern` to target.
- When a test hangs, it's almost always waiting for a condition that will
  never be met. Check what the wait condition expects vs what the real
  Claude flow actually produces. Add logging to the wait loop.

## Architecture

- Batched POSTs with the same `localId` must use last-write-wins semantics.
  The server route was broken (kept first payload, dropped updates) — this
  caused stale tool state and broke Step 1. Fixed in v3SessionRoutes.ts.
- Permission transitions can fire BEFORE the tool part exists in the Claude
  v3 mapper. The permission handler queues and replays in this case.
- The daemon builds from `packages/happy-cli/dist/index.mjs`. If you change
  CLI source, you MUST rebuild before running e2e tests or the daemon runs
  stale code. Run: `yarn workspace happy-cli build`
- The Write tool in Claude is lazily loaded — sessions that never call Read
  first won't have Write available. This is relevant for denied-write tests.

## Process (what works)

- Break "get Steps N-M passing" into individual steps. One step per iteration
  is a good pace. Trying to do too many at once leads to incomplete work.
- When a step fails, paste the actual error/output into loop-state.md so the
  next iteration doesn't re-discover it.
- After fixing code, re-run ONLY the affected step first, then the full
  passing suite (Steps 0-6+) to check for regressions.

## Process (what fails)

- Running unit tests and declaring victory. Unit tests with mocks prove
  nothing about the real daemon/CLI/SyncNode integration.
- Accepting `describe.skip` or env-var skip conditions at face value. The
  CLIs are installed and authenticated — skips for missing API keys are bugs.
- Doing cosmetic cleanup (types, linting, `as any`, comments) while the
  actual e2e task is incomplete. This feels productive but advances nothing.
- Re-reading the entire spec + doing `rg --files` + reading 5 source files
  to "orient." Read loop-state.md, read loop-learnings.md, start working.
- Declaring a task "done" because the code exists. It's done when a test
  run proves it. Paste the test output.
- Rewiring imports or moving files without checking what the previous
  iteration set up. Read git diff HEAD first to see uncommitted work.
