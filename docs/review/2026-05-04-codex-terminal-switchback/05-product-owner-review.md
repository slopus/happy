## WARNING Local Codex default can fail on Windows npm installs
**File:** packages/happy-cli/src/codex/codexLocalLauncher.ts:110
**Issue:** The new terminal default path launches native Codex with `node:child_process.spawn('codex', ...)`, while the existing app-server path intentionally uses `cross-spawn` so npm-installed Windows shims such as `codex.cmd` resolve correctly. Because `happy codex` now defaults to local mode, Windows users who previously reached the remote app-server path can hit `ENOENT` before the native TUI opens.
**Recommendation:** Use the same cross-platform spawn helper for native local Codex, or otherwise resolve platform-specific Codex shims before spawning.
**Rationale:** The PRD makes native/local the default terminal experience. A platform-specific launch failure blocks that primary user story and is user-impacting correctness, not an implementation-style concern.

## WARNING Discovery failures are not surfaced as actionable Happy session errors
**File:** packages/happy-cli/src/codex/runCodex.ts:513
**Issue:** If fresh local thread discovery rejects, including the required ambiguous-discovery case, `runCodex` awaits `launchLocalCodexSession` without catching the error or sending a session event before closing. During mobile handoff this can drop the queued mobile turn into a dead session with no actionable in-app explanation, even though the underlying thrown message is specific.
**Recommendation:** Catch local launch/discovery failures at the mode-loop boundary, emit a visible session message/event with the discovery error, flush it, and only then close or exit. Preserve the thrown error for terminal logs if desired.
**Rationale:** The PRD explicitly requires ambiguous new-session discovery to fail visibly and calls out actionable errors. Visibility needs to reach the Happy session/mobile user, not only an uncaught terminal exception.

## WARNING Enriched command results may change compact mobile rendering
**File:** packages/happy-app/sources/sync/typesRaw.ts:663
**Issue:** The PRD says compact mobile rendering should remain unchanged for now and that enriched command output can be consumed later from the raw `result` payload. This normalization now copies `result.content` into the normalized `tool-result.content`; the existing reducer copies that field into `message.tool.result`, so current compact tool rendering can start showing command stdout/stderr immediately.
**Recommendation:** Keep normalized `content` as `null` for session-protocol `tool-call-end` events and preserve the enriched payload only on the additive `result` property, unless this PR intentionally changes the mobile display contract and the PRD is updated accordingly.
**Rationale:** Command result preservation is required, but this path couples preservation to current app rendering and violates the stated no-rendering-change constraint, creating a user-visible behavior change outside the PRD scope.
