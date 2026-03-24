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
- Steps that ask Claude to set up tooling (npm install, vitest config, etc.)
  can take 100-120s because Claude retries on errors (Bash failures, test
  failures). The inner `waitForStepFinishApprovingAll` timeout must match the
  step's outer timeout or you'll hit a false timeout. Step 13 needs 270s.
- When a test hangs, it's almost always waiting for a condition that will
  never be met. Check what the wait condition expects vs what the real
  Claude flow actually produces. Add logging to the wait loop.
- If a step follows a structural-only success check (for example Step 6 ends as
  soon as the write tool completes), the NEXT step must not wait for a generic
  "first terminal assistant turn" because Claude may still be flushing the
  previous request. Wait for a step-specific signal instead.
- Real Claude Step 16 used the dedicated `TodoWrite` tool in the passing run.
  For todo-flow debugging, look for `TodoWrite` / derived `session().todos`,
  not just prose mentions of the tasks.
- Plain-text "Compact the context." did not emit a `compaction` part in the
  passing Step 18 run. Claude responded with terminal text about `/compact`
  instead, so compaction assertions need to account for vendor-specific
  behavior.
- Tool "terminal state" checks must use strict `completed || error`, not the
  weaker `!== 'running' && !== 'blocked'`. The latter allows `pending` which
  fails the cross-cutting assertion. This mismatch was the root cause of the
  "All tool parts terminal" cross-cutting failure in the March 22 runs.
- Claude uses `TaskOutput` tool with `block: true` to wait for background
  tasks to complete. The tool stays `running` while blocked, then transitions
  to `completed` with the output. Background task steps (31-33) complete
  quickly once TaskOutput returns — Step 32 took 28s (30s sleep + overhead),
  Step 33 took 8.5s (sleep 20 launched, foreground work fast).

## Architecture

- Batched POSTs with the same `localId` must use last-write-wins semantics.
  The server route was broken (kept first payload, dropped updates) — this
  caused stale tool state and broke Step 1. Fixed in v3SessionRoutes.ts.
- Permission transitions can fire BEFORE the tool part exists in the Claude
  v3 mapper. The permission handler queues and replays in this case.
- The daemon builds from `packages/happy-cli/dist/index.mjs`. If you change
  CLI source, you MUST rebuild before running e2e tests or the daemon runs
  stale code. The Yarn workspace name is `happy-coder`, not `happy-cli`.
  Run: `yarn workspace happy-coder build`
- The Write tool in Claude is lazily loaded — sessions that never call Read
  first won't have Write available. This is relevant for denied-write tests.
- Expo web needs a global `Buffer` for the shared `happy-sync` client. Without
  `globalThis.Buffer = Buffer` before `syncRestore()`, the web app
  authenticated successfully but `AppSyncStore.fetchSession()` /
  `connect()` failed with `ReferenceError: Buffer is not defined`, leaving the
  browser on an authenticated shell with `unknown` session metadata and no
  transcript.
- Browser dev credentials must pass the secret in base64url form, not raw
  base64. The app decodes `credentials.secret` with
  `decodeBase64(..., 'base64url')`; feeding it the raw base64 string from the
  e2e setup silently breaks the web session path.

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

## Browser UX Testing

- Claude does NOT reliably use the formal `AskUserQuestion` tool for "Ask me
  which one I want" prompts. It may just list options in text with
  `step-finish(reason=stop)`. The browser test must handle both cases —
  `waitForPendingQuestion` should be wrapped in try/catch with fallback.
- `SyncNode.answerQuestion()` expects `answers: string[][]`, not an object.
  Correct call: `node.answerQuestion(sessionId, questionId, [['Vitest']])`
- `body.indexOf('test framework')` for ordering assertions is fragile because
  Claude's earlier responses may mention the same phrase. Use the exact user
  prompt text (e.g., `'Ask me which one I want'`) for reliable ordering checks.
- The expanded browser UX test runs Steps 1, 2, 3 (deny), 4 (approve), 12
  (question) in ~135s total. Steps 1-4 consistently produce permission prompts.
  The full browser check (navigate + render + assertions) adds ~10s on top.
- The web app renders tool status as exact text labels: "Completed", "Error",
  "Running", "Awaiting approval", "Awaiting answer", "Pending". These are
  reliable for `body.toMatch()` assertions.
- The web app has NO `testID` or `data-testid` attributes. All browser
  assertions must be text-based (`page.textContent('body')` + string matching).
- Permission buttons render as "Yes", "Yes, allow all edits",
  "Yes, don't ask again for this tool", "No, and provide feedback" (Claude).

## @openai/codex-sdk (Codex integration)

- The `@openai/codex-sdk` does NOT support approval callbacks. It only
  accepts an `approvalPolicy` string (`"never"`, `"on-request"`,
  `"on-failure"`, `"untrusted"`) which the SDK handles internally.
  The `setApprovalHandler` / `approvalHandler` in CodexAppServerClient is
  dead code that is never called.
- Approval behavior is determined by the combination of `approvalPolicy`
  and `sandboxMode`. The SDK's sandbox enforcement blocks operations at
  the OS level (e.g., `read-only` sandbox = no writes possible).
- Codex thread events map cleanly to the existing v3 mapper: SDK
  `ThreadEvent` → `EventMsg` → `handleCodexEvent` → v3 messages. The
  event types are: `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`.
- Codex turns are often finalized as a single assistant message with
  `step-finish(reason="tool-calls")` where all tools are terminal. The
  `isCodexTurnSettled` function accounts for this pattern.
- The full Codex e2e suite takes ~22 minutes (1309s) — about 2x longer
  than Claude's ~12 minutes. This is mainly because Codex does more
  tool calls per step (reads files, runs commands, applies patches).
- Old Codex session processes from previous test runs are not cleaned up
  and accumulate. 67+ orphan processes observed after multiple runs.
  The teardown only kills the daemon, not individual sessions.
- Step 30 (retry after stop) is the slowest step at 154s — Codex does
  extensive file reading, editing, and retry cycles.
