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

TASK: Step 1 — Add `acpx` dep to `happy-sync`, re-export acpx types, delete `protocol.ts` and `sessionProtocol.ts`.

### Acceptance criteria
1. `acpx` added as dependency in `happy-sync/package.json`
2. `happy-sync/src/index.ts` re-exports acpx types (`SessionMessage`, `SessionAgentMessage`, `SessionUserMessage`, `SessionAgentContent`, `SessionToolUse`, `SessionToolResult`, `SessionTokenUsage`, `SessionAcpxState`, `SessionRecord`) instead of v3 protocol
3. `happy-sync/src/protocol.ts` — DELETED
4. `happy-sync/src/sessionProtocol.ts` — DELETED
5. `happy-sync/src/protocol.test.ts` — DELETED
6. `happy-sync/src/sessionProtocol.test.ts` — DELETED
7. New `happy-sync/src/session-message.test.ts` with ~15 tests covering:
   - `SessionMessage` variant construction (User, Agent, Resume)
   - `SessionAgentContent` variant handling (Text, Thinking, ToolUse)
   - `SessionToolUse` + `SessionToolResult` matching
   - Encryption round-trip with raw `SessionMessage`
8. `yarn tsc --noEmit` passes in `happy-sync` (expect failures in downstream packages — that's fine, later steps fix those)
