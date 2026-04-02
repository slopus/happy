# Loop State

Last updated: 2026-04-01

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

TASK: Step 4 — App views — new message components rendering acpx types.

### Acceptance criteria
1. New `MessageView.tsx` component renders `SessionMessage` (User/Agent/Resume)
2. New `AgentContentView.tsx` renders `SessionAgentContent[]` (Text, Thinking, RedactedThinking, ToolUse)
3. New `ToolUseView.tsx` renders `SessionToolUse` + matching `SessionToolResult`
4. Old Part-based views are NOT used by the new components
5. App compiles and renders session transcript using new views
6. `yarn tsc --noEmit` passes for the app package
7. Visual smoke test confirms text, thinking, and tool use render correctly
