# Loop State

Last updated: 2026-04-02

Previous completed tasks are archived in `loop/state-archive.md`.

## Mission: acpx Rewrite

Rewrite Happy to use [acpx](https://github.com/openclaw/acpx) types end-to-end.
Delete all custom protocol types. Happy = pure frontend for acpx.

Full plan: `/Users/kirilldubovitskiy/.claude/plans/greedy-giggling-star.md`

Branch: `acpx-rewrite` (from `happy-sync-refactor` at c49d9579)

### What goes on the wire

Raw acpx `SessionMessage` — no envelope, no wrapper:
```typescript
type SessionMessage = { User: SessionUserMessage } | { Agent: SessionAgentMessage } | "Resume";
```

Session metadata carries `SessionAcpxState`, `FlowRunState`, pending permissions.

### Delete targets (~6,200 lines)
- `happy-sync/src/protocol.ts` (640 lines, 14 Part types)
- `happy-sync/src/sessionProtocol.ts` (legacy envelope)
- 5x v3Mappers (claude, codex, gemini, openclaw, acp)
- `AcpSessionManager`, `sessionUpdateHandlers`
- All Part views (`parts/` directory — 8 files)
- `AgentMessage` type + adapters

### Add targets (~390 lines)
- New message views: `MessageView.tsx`, `AgentContentView.tsx`, `ToolUseView.tsx`, `FlowView.tsx`

### Implementation order
1. Add `acpx` dep to `happy-sync`, re-export types, delete `protocol.ts`
2. Update SyncNode to carry `SessionMessage` directly
3. Simplify CLI — AcpBackend + SyncBridge use acpx types
4. App views — new message components rendering acpx types
5. Permission flow via metadata
6. Delete v3 mappers, part views, legacy code
7. Flow UI — FlowView reading `metadata.flow`

### Testing requirements
- ~226 automated tests (rewrite existing, add new for acpx accumulator + metadata)
- 9 manual browser flows via `agent-browser` (session lifecycle, text, tools, permissions, multi-turn, resume, flow, sync, errors)
- `yarn tsc --noEmit` must pass across all packages
- ALL manual flows MUST be tested via agent-browser before merge

## Current Task

DONE: Step 1 — Add `acpx` dep to `happy-sync`, re-export acpx types, delete `protocol.ts` and `sessionProtocol.ts`.

Commit: 50dda64f

### Results
1. ✅ `acpx@^0.4.0` added as dependency in `happy-sync/package.json`
2. ✅ `happy-sync/src/index.ts` re-exports acpx types from new `acpx-types.ts`
3. ✅ `protocol.ts` — DELETED (renamed to `v3-compat.ts` internally for sync-node.ts; NOT re-exported)
4. ✅ `sessionProtocol.ts` — DELETED
5. ✅ `protocol.test.ts` — DELETED
6. ✅ `sessionProtocol.test.ts` — DELETED
7. ✅ `session-message.test.ts` with 17 tests (all pass)
8. ✅ `yarn tsc --noEmit` passes in happy-sync

### Notes
- acpx session types (SessionMessage, etc.) are NOT exported from acpx's public API — only used internally. Defined them in `acpx-types.ts` matching acpx's exact definitions. `FlowRunState`/`FlowStepRecord` re-exported from `acpx/flows`.
- Transport-level `SessionMessage` in `messages.ts` renamed to `TransportMessage` to avoid collision with acpx `SessionMessage`.
- v3 types live in `v3-compat.ts` (internal only) until Step 2 rewrites sync-node.ts.
- `v3` namespace still exported via `export * as v3 from './v3-compat'` for downstream compat until Step 6 deletes it.

---

DONE: Step 2 — Update SyncNode to carry `SessionMessage` directly instead of `ProtocolEnvelope`.

Commit: 6385f7be

### Results
1. ✅ `SyncNode.SessionState.messages` is now `SessionMessage[]`; `controlMessages` removed
2. ✅ `SyncNode.sendMessage()` / `updateMessage()` now take raw acpx `SessionMessage`
3. ✅ Raw `SessionMessage` is encrypted/stored directly; `ProtocolEnvelopeSchema` usage removed
4. ✅ Pending permissions/questions now derive from `metadata.pending.*`
5. ✅ Session status now derives from metadata lifecycle/pending state instead of Part scanning
6. ✅ Runtime config mutations now persist in metadata instead of control messages
7. ✅ `v3-compat.ts` — DELETED
8. ✅ `sync-node.test.ts` rewritten around raw `SessionMessage`
9. ✅ `sync-node.integration.test.ts` rewritten to cover raw-message + metadata flows against the real server
10. ✅ New `sync-types.ts` holds remaining shared non-wire sync types (`SessionInfo`, IDs, `Todo`, `RuntimeConfig`)

### Verification
1. ✅ `yarn workspace @slopus/happy-sync tsc --noEmit`
2. ✅ `yarn workspace @slopus/happy-sync test:unit` — 40/40 tests passed
3. ✅ `yarn workspace @slopus/happy-sync build`
4. ✅ `yarn workspace @slopus/happy-sync test:integration` — 9/9 tests passed
5. ✅ `test ! -e packages/happy-sync/src/v3-compat.ts && echo deleted` → `deleted`
6. ⚠️ `yarn tsc --noEmit` at repo root is not configured in this worktree: it exits with TypeScript help text because there is no root `tsconfig.json`

---

DONE: Step 3 — Simplify CLI — `AcpBackend` + `SyncBridge` use acpx types directly.

Commit: ffb0df69

### Results
1. ✅ ACP sync path (`runAcp.ts`) no longer imports `v3`, `v3Mapper`, or constructs `ProtocolEnvelope`/`MessageWithParts`
2. ✅ AcpBackend events flow through new `SessionAgentMessage` accumulator in `runAcp.ts` → raw `{ Agent: ... }` messages
3. ✅ `SyncBridge` rewritten: accepts raw `SessionMessage`, no v3 types, forwards directly to `SyncNode`
4. ✅ Permission decisions come from `onStateChange` → `session.permissions[].decision` (metadata-derived)
5. ✅ Runtime config changes come from `onStateChange` → `session.runtimeConfig` (metadata-derived)
6. ✅ Abort requests detected from `agentState.lastAbortRequest` changes
7. ✅ `runAcp.test.ts` updated: 9 tests pass with acpx message format and metadata-based config
8. ✅ `yarn workspace happy-coder build` passes
9. ✅ `yarn workspace happy-coder vitest run src/agent/acp/` — 40/40 tests pass
10. ✅ `yarn workspace @slopus/happy-sync test:unit` — 40/40 tests pass

### Notes
- `v3-compat.ts` restored from git (640 lines) and re-exported as `v3` namespace for non-ACP runners (Claude, Codex, Gemini, OpenClaw). Will be deleted in Step 6.
- Non-ACP runners patched with `as any` casts for SyncBridge type changes (accepting `SessionMessage` instead of `MessageWithParts`). These files are untouched in substance.
- `PermissionRequest` and `QuestionRequest` types in sync-node.ts now carry `decision`, `allowTools`, `reason`, `answers` fields for downstream consumers.
- `UserMessageCallback` now passes `{ User: SessionUserMessage }` instead of `MessageWithParts`. Non-ACP runners use `(message: any)` casts.
- The acpx accumulator in `runAcp.ts` builds `SessionAgentMessage` directly from `AgentMessage` events: text → `{ Text }`, thinking → `{ Thinking }`, tool-call → `{ ToolUse }`, tool-result → `tool_results` map.

---

DONE: Step 4 — App views — new message components rendering acpx types.

Commit: 79dd3c75

### Results
1. ✅ `packages/happy-app/sources/components/MessageView.tsx` renders raw `SessionMessage` variants directly (`User`, `Agent`, `Resume`)
2. ✅ `packages/happy-app/sources/components/AgentContentView.tsx` now renders `SessionAgentContent[]` blocks directly (`Text`, `Thinking`, `RedactedThinking`, `ToolUse`)
3. ✅ `packages/happy-app/sources/components/ToolUseView.tsx` renders `SessionToolUse` plus its matching `SessionToolResult`; input only shows once `is_input_complete === true`
4. ✅ Transcript pipeline rewired off the Part model: `ChatList`, message detail route, `AppSyncStore`, storage hooks, and voice context formatters now consume raw acpx `SessionMessage`
5. ✅ Old Part-based views are not used by the new transcript components (`ChatList` no longer renders `parts/V3MessageView`)
6. ✅ Added `SessionContentView.tsx` to keep the old keyboard/layout shell separate from the new `AgentContentView.tsx` transcript renderer
7. ✅ Added targeted app tests for `MessageView`, `AgentContentView`, and `ToolUseView`
8. ✅ Added placeholder `FlowView.tsx` so the acpx transcript component set exists ahead of Step 7

### Verification
1. ✅ `yarn workspace happy-app typecheck`
2. ✅ `yarn workspace happy-app test --run sources/components/MessageView.test.ts sources/components/AgentContentView.test.ts sources/components/ToolUseView.test.ts`
3. ✅ Visual render smoke covered by the new transcript component tests for text, thinking, resume markers, tool input, tool output, and tool errors
4. ⚠️ `yarn tsc --noEmit` at repo root still exits with TypeScript help text because this worktree has no root `tsconfig.json`

---

DONE: Step 5 — Permission flow via metadata.

Commit: 3871ec33

### Results
1. ✅ `ToolUseView.tsx` reads pending permissions/questions from `useSyncSessionState()` → `session.permissions[]` / `session.questions[]`, not v3 ToolPart blocks
2. ✅ Permission approve/deny uses `PermissionFooter` with `getPermissionStatus()` mapping `PermissionRequest` → footer props; calls `sessionAllow`/`sessionDeny` via metadata-backed ops
3. ✅ Question answer flow uses new `ToolUseQuestionView` component reading `QuestionRequest` from metadata; calls `sessionAnswerQuestion` via metadata-backed ops
4. ✅ `transcriptUtils.ts` extended: `getToolUseState()` now accepts optional `PermissionRequest`/`QuestionRequest` and returns `'awaiting_approval'`/`'awaiting_answer'` states; `findPermissionForTool()`/`findQuestionForTool()` helpers match `callId` to `toolUse.id`
5. ✅ Tool status labels in `ToolUseView` show "Awaiting approval" / "Awaiting answer" / "Approved" / "Denied" from metadata state
6. ✅ 13 tests pass: 3 original + 10 new (pending/approved/denied/always permissions, pending/resolved questions, AskUserQuestion exclusion, no-match, no-session)
7. ✅ `yarn workspace happy-app typecheck` passes
8. ✅ `yarn workspace @slopus/happy-sync tsc --noEmit` passes

### Notes
- `PermissionFooter.tsx` unchanged — it already accepts a generic permission props object. `getPermissionStatus()` in `ToolUseView.tsx` bridges `PermissionRequest` → footer interface.
- `ToolUseQuestionView.tsx` is a new component (~260 lines) — metadata-backed port of `AskUserQuestionView.tsx` that accepts `QuestionRequest` directly instead of `ToolViewProps`.
- `AskUserQuestionView.tsx` (old, part-based) still exists for backward compat until Step 6 deletes it.
- `ToolUseView` shows `PermissionFooter` for all tools EXCEPT `AskUserQuestion`, which gets `ToolUseQuestionView` instead.

---

DONE: Step 6 — Delete v3 mappers, part views, legacy code.

### Results
1. ✅ All 5 v3 mappers deleted (`claude`, `codex`, `gemini`, `openclaw`, `acp`) along with the stale Claude/Codex mapper tests
2. ✅ `packages/happy-app/sources/components/parts/` deleted from disk
3. ✅ Old part-based app surface removed: `ToolView.tsx`, `AskUserQuestionView.tsx`, and the `dev/tools2` route are deleted and no longer imported
4. ✅ `export * as v3 from './v3-compat'` removed from `packages/happy-sync/src/index.ts`
5. ✅ Live source tree no longer has `v3` imports/usages outside legacy compatibility/e2e fixtures
6. ✅ Added shared `packages/happy-cli/src/session/acpxTurn.ts` to replace the per-runner mapper accumulation path
7. ✅ Added `packages/happy-cli/src/session/acpxTurn.test.ts` with focused coverage for raw agent events plus Claude assistant/user tool-result translation

### Verification
1. ✅ `yarn workspace happy-coder build`
2. ✅ `yarn workspace happy-app typecheck`
3. ✅ `yarn workspace @slopus/happy-sync tsc --noEmit`
4. ✅ `yarn workspace happy-app test --run sources/components/MessageView.test.ts sources/components/AgentContentView.test.ts sources/components/ToolUseView.test.ts` — 17/17 tests passed
5. ✅ `yarn workspace happy-coder vitest run src/session/acpxTurn.test.ts` — 4/4 tests passed
6. ✅ `yarn workspace @slopus/happy-sync test:unit` — 40/40 tests passed
7. ⚠️ `yarn tsc --noEmit` at repo root still exits with TypeScript help text because this worktree has no root `tsconfig.json`

---

TASK: Step 7 — Flow UI — `FlowView` reading `metadata.flow`.

### Acceptance criteria
1. `FlowView.tsx` renders `session.metadata.flow` / `metadata.flow` state directly, not Part-derived flow data
2. Transcript/session UI shows flow status from metadata without relying on legacy protocol types
3. Flow rendering updates correctly as metadata changes across steps and terminal states
4. Automated app tests cover at least one active flow state and one completed flow state
5. `yarn workspace happy-app typecheck` passes
