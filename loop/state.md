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

TASK: Step 2 — Update SyncNode to carry `SessionMessage` directly instead of `ProtocolEnvelope`.

### Acceptance criteria
1. `SyncNode.SessionState.messages` typed as `SessionMessage[]` (not `MessageWithParts[]`)
2. `SyncNode.SessionState.controlMessages` removed (permissions/config in metadata now)
3. `SyncNode.sendMessage()` accepts `SessionMessage` directly
4. `SyncNode.updateMessage()` accepts `SessionMessage` directly
5. Permission derivation reads from `metadata.pending.permissions[]` (not from message Parts)
6. Session status derived from metadata lifecycle state (not from Part scanning)
7. `ProtocolEnvelopeSchema` no longer used — raw `SessionMessage` encrypted directly
8. `v3-compat.ts` — DELETED (no longer needed)
9. `sync-node.test.ts` updated: tests use `SessionMessage` instead of `MessageWithParts`
10. `yarn tsc --noEmit` passes in `happy-sync`
