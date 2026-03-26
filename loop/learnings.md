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
- OpenCode can emit `status: idle` between phases of a single prompt and then
  resume a second or two later with more tool activity. For OpenCode e2e waits,
  add a short quiet-period check before treating an idle, no-permission turn as
  settled.
- OpenCode Step 13 is more reliable if the follow-up branch waits for the real
  artifact requirement (Vitest files exist) while continuing to auto-approve
  permissions, instead of waiting for OpenCode's `apply_patch` tool to emit a
  terminal completion event.
- In the widened OpenCode Steps 0-13 run, Step 13 still passed even when the
  last tool part finished as `edit:error`. The durable proof is the created
  files on disk, not a successful terminal edit tool.
- In the passing OpenCode Steps 21-30 run, Steps 25-27 each spent ~150s on a
  single `edit` / `other` tool before resolving as `error`. For these later
  OpenCode steps, the durable proof is the artifact / family-session outcome
  plus a terminal tool state, not specifically `completed`.
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
- OpenCode ACP permission requests for edit-style tools can carry the full file
  write payload in `toolCall.rawInput` / permission metadata. Happy can
  materialize those approved writes locally even if OpenCode never reports a
  terminal `apply_patch` completion.
- ACP tool-call timeouts need to emit a terminal `tool-result` error, not just
  clear internal active-tool tracking. Silent timeout cleanup leaves the
  transcript structurally inconsistent and can strand later waits.
- The ACP v3 mapper must not start a new assistant turn for metadata-only
  backend events. If it does, OpenCode produces stray empty `step-start`
  messages after otherwise-finished turns.
- `@slopus/happy-sync` builds without DOM libs in its tsconfig, but the build
  still compiles its Playwright e2e files. In that package, browser callbacks
  must not reference bare `document`; use typed `globalThis.document` access or
  fresh installs/builds can fail before `happy-coder` can rebuild.
- OpenCode can leave the ACP `prompt` RPC unresolved even after the transcript
  has settled and `runAcp` has already finalized the turn locally. The NEXT
  user prompt must not treat that stale RPC as fatal. Best fix: send a
  best-effort `session/cancel`, wait briefly, then detach from the stale RPC
  and continue. Otherwise Step 14+ can kill the whole OpenCode runner after a
  successful Step 13.
- Standalone PGlite + Prisma bytes handling does not reliably round-trip
  `Session.dataEncryptionKey`. Because `SyncNode.createSession()` always sends
  that key, Level 1 session create/list paths can 500 under tests unless
  `sessionRoutes.ts` uses raw PGlite SQL (or the adapter is fixed). Re-test
  `/v1/sessions` POST/GET with encryption enabled whenever the storage layer
  changes.
- The PGlite Bytes bug also affects socket CAS handlers in
  `sessionUpdateHandler.ts`. ALL `db.session.findUnique` calls that might return
  a session with `dataEncryptionKey` must use `select` to exclude it. Without
  this, `update-metadata` and `update-state` silently return `{result:'error'}`
  and the CAS update never succeeds. Also `stopSession` route's `db.session.update`
  needs `select: { id: true }` to avoid returning the bytes column.
- `SyncNode.createSession()` must initialize `metadataVersion`/`agentStateVersion`
  from the server response, not hardcode 0. Otherwise immediate-after-create CAS
  updates can version-mismatch if the server's initial version is non-zero.

## Process (what works)

- Break "get Steps N-M passing" into individual steps. One step per iteration
  is a good pace. Trying to do too many at once leads to incomplete work.
- When a step fails, paste the actual error/output into loop-state.md so the
  next iteration doesn't re-discover it.
- After fixing code, re-run ONLY the affected step first, then the full
  passing suite (Steps 0-6+) to check for regressions.

## CRITICAL: Global daemon safety

- On 2026-03-24, a test run triggered `daemon start-sync` which sent SIGTERM to
  the global daemon (PID 39581), killing ALL 5 active user sessions including
  the human's active session. This is a **showstopper bug**.
- The daemon version-mismatch restart logic will kill the global daemon if any
  test or CLI invocation triggers it. Tests MUST use isolated daemon instances.
- NEVER kill, restart, or signal the global daemon or any sessions you didn't
  spawn. Only clean up processes YOUR tests created (identifiable by temp dirs
  or test-specific ports).
- `ps eww` is enough to identify test-owned daemons safely: the isolated e2e
  harness exports `MODE=test`, `HAPPY_HOME_DIR=/tmp/happy-e2e-.../daemon-home`,
  and temp project/PGlite paths. Only kill processes that carry those exact
  temp-dir markers; leave anything without them alone.

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

- `AppSyncStore.getMessages()` must return a shared empty array when a session
  has not hydrated yet. `useV3SessionMessages()` is backed by
  `useSyncExternalStore`; if `getSnapshot()` sees a fresh `[]` on each read,
  React logs `"The result of getSnapshot should be cached"` and can cascade
  into `"Maximum update depth exceeded"` inside `<SessionViewLoaded>`.
- Expo Router web imports dev-route modules during route discovery. A broken
  dev-only screen can take down unrelated browser e2e tests before
  `/session/:id` ever renders. On March 25, `dev/qr-test`,
  `dev/session-composer`, and `dev/unistyles-demo` all needed web-safe
  handling before the real session-page crash could even be reproduced.
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

## Smart Zustand / Amendment 4

- The fine-grained selectors (`useV3SessionMessages`, `useV3Message`,
  `useV3ToolPart`, `useSyncSessionState`) were already implemented before
  Amendment 4 started. The main work was migrating remaining old-path
  consumers (`agentState.requests`, `agentState.controlledByUser`,
  `session.thinking`) to read exclusively from SyncNode.
- `FaviconPermissionIndicator` has a pre-existing rules-of-hooks violation
  (hooks called after conditional early return) AND an unstable array selector
  that produces new references on every Zustand notification. Fix the selector
  with `useShallow` from `zustand/react/shallow`.
- The `storage.ts:applySessions` reducer can safely read from
  `sync.appSyncStore?.getSession()` — it's a getter with no side effects.
  But be careful about triggering cascading state updates from inside reducers.
- The web app "Maximum update depth exceeded" crash (blocking browser tests
  since March 25) is NOT in the Amendment 4 code. It's in the committed code
  from the March 24 commit. Stashing all Amendment 4 changes reproduces it.
  The crash is in `<SessionViewLoaded>` or `<FaviconPermissionIndicator>` and
  manifests as soon as any session page is opened in Chrome via Playwright.
- Phase 1 manual browser walkthrough (March 26, 2026): wrote a standalone boot
  script (`phase1-boot.ts`) that replicates the e2e setup code outside Vitest.
  Key issue encountered: setting `CLAUDE_CONFIG_DIR` to a fake config dir broke
  Claude CLI auth ("Not logged in"). The existing e2e tests do NOT set this env
  var — they use the real `~/.claude/` auth. The Happy CLI defaults to
  `permissionMode: 'default'` via `currentPermissionMode || 'default'` in
  `runClaude.ts`, regardless of the user's `~/.claude/settings.json` bypass
  setting. But because the daemon inherits `process.env` and the real user has
  `bypassPermissions`, the spawned Claude CLI does auto-approve in practice.
- `agent-browser` (the CLI tool) works for page-level screenshots and text
  extraction but has limited support for tab management. For multi-tab testing
  (close tab and reopen, switch tabs), Playwright in e2e tests is better.
- Vitest leaks `NODE_ENV=test` into spawned child processes unless the test
  overrides it. Expo Router web treats that as a different transform mode and
  can fail on `node_modules/expo-router/_ctx.web.js` with
  `process.env.EXPO_ROUTER_APP_ROOT`. The Level 3 web server child must force
  `NODE_ENV=development`.
- The first Expo web `.bundle` compile in the browser e2e path can take far
  longer than the earlier smoke runs — on March 26 it needed a 300s timeout.
  Wait for Metro's `Waiting on http://localhost:<port>` log before requesting
  the bundle, then give that first bundle request a long budget.
- Browser transcript assertions against synced assistant text need Markdown
  normalization. The raw synced text can contain `**bold**`, headings, or code
  ticks, while the visible DOM renders plain text. Strip Markdown markers
  before comparing snippets.
- Repeated `page.goto()` navigation between authenticated Happy routes can emit
  benign aborted-fetch warnings (`TypeError: Failed to fetch`,
  `AppSyncStore fetchSession failed ... TypeError: Failed to fetch`) during
  page teardown. Filter only this exact aborted-navigation form; do NOT filter
  other `AppSyncStore` or `pageerror` failures.
