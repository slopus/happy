# Provider Envelope Testing — Wire v3 E2E and Prove It

Status: **IN PROGRESS — happy path works, edge cases broken, tests unreliable**
Depends on: `provider-envelope-redesign.md`
Branch: `messaging-protocol-v3`

## Testing Levels

Three levels. All three must pass for anything to count as working.

### Level 1: Unit tests (vitest, no server, no provider)

Feed hand-built SDK messages into the mapper, assert correct v3
envelope comes out. Feed hand-built v3 envelopes into the converter,
assert correct app messages come out. Fast, deterministic, catches
regressions in mapping logic. Currently 51 tests.

**Files:** `v3Mapper.test.ts`, `v3Mapper.wiring.test.ts`,
`codex/v3Mapper.test.ts`, `v3Converter.test.ts`,
`v3Protocol.integration.test.ts`

### Level 2: Integration tests (vitest, real server + daemon + provider API)

Boot a real environment, spawn a real session, send real messages.
Claude/Codex actually calls the API, tools actually execute on disk.
Read history via happy-agent CLI, assert v3 envelopes have the right
structure — right number of messages, right tool states, right
permission decisions, file actually changed on disk. This is the
"does the plumbing work" level. Currently 9 tests, 4 broken.

**Files:** `v3-claude.integration.test.ts`, `v3-codex.integration.test.ts`

### Level 3: Browser verification (agent-browser, real server + web app)

Same real session from level 2, but open it in the web UI. Screenshot
and inspect: no duplication, no raw JSON, correct ordering, permissions
render as cards, bash renders as terminal, thinking is collapsible,
user messages show correctly. This is the "does a human see the right
thing" level. Currently done manually, should be automated with
agent-browser.

Level 1 catches mapper bugs. Level 2 catches wiring bugs. Level 3
catches rendering bugs. If vitest is green but the browser shows
duplicated cards or raw JSON, the test is BROKEN.

**LEVEL 2 AND LEVEL 3 ARE ESSENTIAL.** Both must cover the FULL
exercise flow from `environments/lab-rat-todo-project/exercise-flow.md`
— all 24 steps, for both Claude and Codex. Not a subset. Not "a few
steps to check the happy path." The entire flow. If the integration
test doesn't exercise a step, that step is untested. If the browser
verification doesn't confirm a step, that step is unverified.

---

## Common Mistakes

Things that have burned time repeatedly. Read this before touching
anything.

1. **Timeouts on `--wait` and shell commands.** Agents take 30-120s
   per turn. If you set a 10s timeout you will get stuck. Use 300s
   minimum for `--wait`. For shell scripts, use `timeout 600` or
   equivalent. Never assume a turn completes quickly.

2. **Always wait for idle before sending the next message.** Unless
   you are DELIBERATELY testing interruption (step 10), always
   `happy-agent wait <session-id> --timeout 300` before sending the
   next message. Sending while the agent is busy causes undefined
   behavior — queued messages, race conditions, lost responses.

3. **Permission steps must NOT use `--wait`.** When Claude will block
   on a permission prompt, `--wait` hangs forever. Send without
   `--wait`, poll `agentState.requests` for the permission request,
   act on it (approve/deny), THEN wait for idle.

4. **`HAPPY_V3_PROTOCOL` env var propagation.** The daemon spawns
   child processes. Env vars must be in the daemon's own environment
   (set in `env.sh`) to propagate. Setting them only when calling
   `happy-agent` does nothing for the session process. (Goes away
   once we kill the flag and make v3 unconditional.)

5. **Project files get modified by earlier sessions.** The lab-rat
   project files (app.js, styles.css, index.html) get edited by
   Claude/Codex during testing. Always reset them from the template
   before starting a new test session:
   ```
   cp environments/lab-rat-todo-project/{app.js,styles.css,index.html} $HAPPY_PROJECT_DIR/
   ```

6. **v3 messages arrive async after turn completion.** After `--wait`
   returns, the v3 envelope may not be stored on the server yet. Poll
   history for v3 messages to appear instead of reading immediately.

7. **Don't send intermediate v3 envelopes.** The `currentAssistant`
   partial update causes duplication in history. Only send finalized
   messages. Permission state changes update mapper state in memory
   only — the finalized message on turn completion has the final state.

---

## Key Decision: Kill the v1 path on CLI side

**`HAPPY_V3_PROTOCOL` env flag is dead.** The CLI always sends v3. No
flag, no dual-write, no conditional. Rip out all the `if (process.env.HAPPY_V3_PROTOCOL)` guards.

**Rationale:** The flag adds complexity for zero value. The CLI and app
ship together. Once the CLI is updated, assume the app is updated too.

**Where v1 must still work:** The app's `sync.ts` must still handle v1
messages because old sessions in history will have them. The
`normalizeRawMessage` path stays. `isV3Envelope` check stays. Both
ingestion paths (batch + real-time) handle both formats. New sessions
will only have v3.

**What to change:**
- `apiSession.ts`: remove all `process.env.HAPPY_V3_PROTOCOL` guards.
  Always create v3 mapper state. Always call `sendClaudeV3Message`.
  Never call v1 `mapClaudeLogMessageToSessionEnvelopes` or
  `sendSessionProtocolMessage` from the Claude/Codex paths.
- `runCodex.ts`: remove v1 `mapCodexMcpMessageToSessionEnvelopes` call
  entirely. Always use v3 mapper.
- `v3Mapper.ts`: remove lazy init guard — create state in constructor.
- Delete `HAPPY_V3_PROTOCOL` from `env.sh`.
- Update tests that reference the flag.

---

## Honest Status

### What ACTUALLY works (proven with real sessions + browser)

- v3 mapper converts Claude SDK messages → v3 envelopes
- v3 mapper converts Codex events → v3 envelopes
- v3 converter converts envelopes → app messages
- App renders v3 messages in the web UI
- v3-only mode — 0 v1 messages in new sessions
- Permission deny flow (Claude): tool blocked → denied → error state
- Permission approve flow (Claude): tool blocked → approved → completed
- Stop mid-stream: session stops, resumes cleanly
- /compact: context compacted, Claude remembers after
- Bug fix on disk: `!item.done || item.done` → `item.done` confirmed

### What is BROKEN

1. **Integration tests: 4/9 FAILING**
   - Timing issues — tests read history before v3 messages arrive
   - Permission steps hang because `--wait` blocks on permission
   - Dual-write assertions expect v1 > 0 but v1 is now always 0
   - These are test bugs, not protocol bugs, but they're still broken

2. **Bug fixes NOT verified in browser**
   - Permission duplication fix (code changed, never re-screenshotted)
   - Text duplication fix (code changed, never re-screenshotted)
   - Codex bash normalization (code changed, never re-screenshotted)
   - All three fixes were applied, CLI rebuilt, daemon restarted,
     sessions spawned — but nobody opened the browser to check the
     LATEST sessions. The screenshots we have are from BEFORE the fixes.

3. **Unit tests NOT re-run after latest mapper changes**
   - The rebuild-parts-from-scratch change in `handleAssistantMessage`
     may break existing `v3Mapper.test.ts` and `v3Mapper.wiring.test.ts`
   - Last confirmed green was BEFORE that change

4. **Codex mapper still accumulates parts old-style**
   - `handleCodexEvent` in the Codex v3 mapper wasn't changed — it still
     appends parts. If Codex sends repeated events (e.g. streaming text
     deltas), the same issue could appear.
   - Not confirmed broken, but not confirmed working either.

5. **`flushClaudeV3Turn` / `flushCodexV3Turn` data loss**
   - If session is killed before flush, the last turn's v3 messages are
     lost forever. No recovery mechanism.

6. **`parentID` chain never verified**
   - Multi-turn conversations produce v3 messages with `parentID` linking
     to the previous user message. Never checked if this chain is correct.

7. **Error tool states (non-permission) never tested**
   - What happens when a tool execution fails (not permission denied,
     just tool error)? Never tested.

### What is COMPLETELY UNTESTED

1. **Plan mode** — `EnterPlanMode` / `ExitPlanMode` tool flow. The
   permission handler has special-case code for plan mode (`PLAN_FAKE_RESTART`,
   `PLAN_FAKE_REJECT`). None of this has been exercised with v3.

2. **Subagent/Task tool** — parallel child task delegation. The mapper
   tracks `taskToolIds` but this was never exercised.

3. **Web search** — external fetch tool parts. Never tested.

4. **Question blocking** — `blockToolForQuestion` / `unblockToolWithAnswers`.
   The mapper has this code, the wiring test covers it, but never tested
   against a real provider.

5. **Model switch** — changing model mid-session. Never tested.

6. **Session metadata** — no v3 indicator anywhere. The UI has no way
   to tell if a session is v3 or v1. No `protocolVersion` in metadata.

7. **Live streaming** — deliberately disabled. Messages only appear
   after the turn completes. A session with a 2-minute Claude response
   shows nothing until the very end.

8. **User message rendering** — user messages in v3 format were never
   verified in the browser. They might render, they might not.

9. **Multi-step tool chains** — Claude calling Read then Edit then Read
   in sequence within one turn. Each tool gets a part, but the ordering
   and completion states across a chain were never verified.

---

## Bugs Found and Fixed

### Bug 1: Double rendering (dual-write)

**Root cause:** CLI sent BOTH v1 and v3 for every event. App processed
both.

**Fix:** Skip v1 when `HAPPY_V3_PROTOCOL=1`. (Will become permanent —
v1 path removed entirely per "Kill v1" decision above.)

**Files:** `apiSession.ts`, `runCodex.ts`

**Caveat:** `HAPPY_V3_PROTOCOL` must be in daemon's env (set in `env.sh`)
so it propagates to child processes. First few test rounds failed because
the var wasn't propagating. This goes away when we kill the flag.

### Bug 2: Permission state duplication

**Root cause:** `blockToolForPermissionV3`, `unblockToolApprovedV3`,
`unblockToolRejectedV3` each sent a v3 envelope. One denied Edit = 3
server messages = 3 tool cards.

**Fix:** These methods now only update mapper state in memory. No envelopes
sent. Finalized message on turn completion has the final state.

**Files:** `apiSession.ts`

### Bug 3: Duplicate text parts from streaming

**Root cause:** Claude SDK sends cumulative snapshots. Mapper appended new
TextParts on each call. N streaming updates = N copies of the same text.

**Fix:** Mapper rebuilds text/reasoning parts from scratch on each call.
Keeps step-start and tool parts.

**Files:** `v3Mapper.ts`

**NOT VERIFIED:** Unit tests not re-run after this change.

### Bug 4: Intermediate v3 envelopes stored on server

**Root cause:** `sendClaudeV3Message` sent `currentAssistant` partial on
every SDK message. All stored on server. History shows all intermediate
snapshots.

**Fix:** Removed `currentAssistant` sending. Only finalized messages sent.

**Files:** `apiSession.ts`

**Trade-off:** No live streaming. Messages appear only after turn completes.

### Bug 5: Codex bash tool renders raw JSON

**Root cause:** Codex mapper stores full event object as tool input.
Converter passes it through. UI dumps raw JSON.

**Fix:** `normalizeBashInput()` in `v3Converter.ts` extracts command,
strips shell wrapper.

**NOT VERIFIED:** Never re-screenshotted after fix.

### Bug 6: Message ordering within a v3 message

**Root cause:** All parts get same `createdAt`. Sort order undefined.

**Fix:** `partOffset++` per part in `convertAssistantMessage`.

**Files:** `v3Converter.ts`

---

## Test Status

### Unit tests: 51/51 — LAST CONFIRMED GREEN BEFORE LATEST CHANGES

```
v3Mapper.test.ts          — 13 passed (may be broken after rebuild-parts change)
v3Mapper.wiring.test.ts   —  9 passed (may be broken after rebuild-parts change)
codex/v3Mapper.test.ts    —  9 passed
v3Converter.test.ts       — 10 passed (may be broken after normalizeBashInput)
v3Protocol.integration.test.ts — 10 passed
```

**NEED TO RE-RUN ALL OF THESE AFTER LATEST CHANGES.**

### Integration tests: 5 passed, 4 failed, 6 skipped — BROKEN

Failures:
1. step 1: reads history immediately, 0 v3 messages (timing)
2. step 3: permission deny — `--wait` hangs on permission
3. step 4: permission approve — same hang
4. step 6: cascading failure from step 5

Required fixes:
- Poll for v3 messages after `--wait` instead of reading immediately
- Don't use `--wait` for permission steps — send, poll, act, then wait
- Remove dual-write assertion entirely (v1 is dead)

---

## Goal

Make EVERYTHING work. Every broken item, every untested item, every
unverified fix listed in this document. No partial credit. No "timing
issue" excuses. No "code changed but never checked in browser". Done
means: unit tests green, integration tests green, browser screenshots
confirming every flow, v1 path dead on CLI side, and every item in
"What is BROKEN" and "What is COMPLETELY UNTESTED" is fixed and proven.

### The flow being tested

The exercise flow is defined in
`environments/lab-rat-todo-project/exercise-flow.md` — 24 steps, one
continuous session, each step builds on the last. It covers:

```
Step 0:  Setup — open agent, point at project
Steps 1-2:  Transcript — read files, find bug, text + reasoning
Steps 3-6:  Permissions — reject, allow once, allow always, auto-approve
Step 7:     Web search — external fetch
Step 8:     Subagents — parallel child tasks
Step 9:     Tools — simple edit
Steps 10-11: Interruption — cancel mid-stream, resume
Steps 12-13: Question — agent asks, user answers, act on answer
Steps 14-15: Sandbox — read/write outside project boundary
Step 16:    Todo — create tracked tasks
Step 17:    Model switch — different model mid-session
Steps 18-19: Compaction — compact, verify memory
Steps 20-22: Persistence — close, reopen, verify continuity
Step 23:    Todo (continued) — mark task done after session break
Step 24:    Summary — git-style changelog spanning all 24 steps
```

Primitives covered (from exercise-flow.md):
- Transcript: text response, reasoning, streaming, multi-step turns
- Tools: completed, errored, with output, multi-file edit, file on disk
- Permissions: reject→error, once→completed, always→rule, auto-approve, sandbox deny
- Web search, subagents, interruption, question blocking
- Todo tracking, model switch, compaction, persistence

Every step must produce correct v3 envelopes on the CLI side and render
correctly in the web UI. The integration tests must exercise this flow
for both Claude and Codex and pass reliably.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/happy-agent/src/session.ts` | sendRpc, approve/deny, waitForPermission |
| `packages/happy-agent/src/index.ts` | approve/deny/permissions CLI commands |
| `packages/happy-cli/src/api/apiSession.ts` | v3-only, no partials, no permission envelopes |
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | Call v3 blocking |
| `packages/happy-cli/src/claude/utils/v3Mapper.ts` | Rebuild text parts from scratch |
| `packages/happy-cli/src/codex/runCodex.ts` | v3-only, remove v1 mapping |
| `packages/happy-app/sources/sync/sync.ts` | v3 detection at both ingestion points |
| `packages/happy-app/sources/sync/storage.ts` | applyDirectMessages |
| `packages/happy-app/sources/sync/v3Converter.ts` | normalizeBashInput, partOffset ordering |
| `packages/happy-agent/src/v3-claude.integration.test.ts` | Exists, BROKEN (timing) |
| `packages/happy-agent/src/v3-codex.integration.test.ts` | Exists, BROKEN (skipped) |
| `packages/happy-cli/src/claude/utils/v3Mapper.wiring.test.ts` | May be broken after mapper changes |
