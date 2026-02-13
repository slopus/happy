# Session Protocol Implementation

## Overview

Implement `docs/session-protocol.md` as the new message format for Codex sessions in the CLI, and add client-side support in `happy-app` to parse, normalize, and render these messages alongside existing legacy formats (output, codex, acp).

**Key decisions from planning:**
- CLI (Codex only): Emit session-protocol events **instead of** current codex/acp format to the server
- App: Support **both** legacy and session-protocol formats (detect and handle both)
- Conversion happens on CLI level; client normalizes the flat event stream back into grouped structures (subagent nesting, turn grouping)

## Context

### Message flow today (Codex → App)

1. `runCodex.ts` receives MCP messages from Codex CLI
2. Calls `session.sendCodexMessage()` which wraps in `{ role: 'agent', content: { type: 'codex', data: body } }`
3. Encrypted and sent via WebSocket
4. App decrypts → `normalizeRawMessage()` in `typesRaw.ts` → `NormalizedMessage`
5. `reducer.ts` processes `NormalizedMessage[]` → `Message[]` for UI

### What changes

- **CLI**: Instead of `sendCodexMessage()`, use a new `sendSessionProtocolMessage()` that emits the 7 event types from session-protocol.md
- **App**: `typesRaw.ts` gets a new discriminated union branch `type: 'session'` in `rawAgentRecordSchema`, with `normalizeRawMessage()` converting session-protocol events to `NormalizedMessage`
- **Reducer**: Minimal changes — already handles `NormalizedMessage` correctly; just needs turn tracking awareness

### Files involved

**CLI (happy-cli):**
- `src/api/apiSession.ts` — new `sendSessionProtocolMessage()` method
- `src/codex/runCodex.ts` — convert from `sendCodexMessage()` to session-protocol events
- `src/codex/utils/reasoningProcessor.ts` — emit thinking events

**App (happy-app):**
- `sources/sync/typesRaw.ts` — new Zod schema for session-protocol envelope + events, new normalizer branch
- `sources/sync/reducer/reducer.ts` — turn tracking (optional, for grouping)
- `sources/sync/reducer/messageToEvent.ts` — handle session-protocol `turn-start`/`turn-end`

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility (legacy formats keep working)

## Testing Strategy
- **Unit tests**: required for every task
- Tests live colocated with source files (`.test.ts` suffix)
- Framework: Vitest

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- ⚠️ `packages/happy-cli` and `packages/happy-app` do not define a `lint` script; verification used full test suites plus `yarn typecheck` in both packages.
- ⚠️ In app normalization for `content.type === 'session'`, `uuid` uses envelope `id` (not `turn`) to keep message identity unique while `invoke` handles sidechain linkage.
- ⚠️ `ReasoningProcessor` and `DiffProcessor` still emit legacy internal shapes; Codex now maps those outputs to session-protocol envelopes in `sessionProtocolMapper.ts` before sending.

## Implementation Steps

### Task 1: Define session-protocol types and Zod schemas (shared)

Create the TypeScript types and Zod schemas for all 7 session-protocol event types plus the envelope. These will be used by both CLI (for emitting) and app (for parsing).

- [x] Create `packages/happy-cli/src/sessionProtocol/types.ts` with:
  - Envelope type: `{ id, time, role, turn?, invoke?, ev }`
  - Event union type discriminated by `ev.t`: `text`, `tool-call-start`, `tool-call-end`, `file`, `photo`, `turn-start`, `turn-end`
  - Each event type as a separate interface
  - Zod schemas for validation
- [x] Export a helper `createEnvelope(role, ev, opts?)` that generates cuid2 id and timestamp
- [x] Write tests for Zod schema validation (valid events pass, invalid rejected)
- [x] Write tests for `createEnvelope` helper
- [x] Run tests — must pass before next task

### Task 2: Add `sendSessionProtocolMessage()` to `apiSession.ts`

Add a new send method that wraps session-protocol envelopes in the wire format.

- [x] Add `sendSessionProtocolMessage(envelope)` to `ApiSessionClient` in `packages/happy-cli/src/api/apiSession.ts`
  - Wraps as `{ role: envelope.role, content: { type: 'session', data: envelope } }`
  - Encrypts and sends via socket (same pattern as `sendCodexMessage`)
- [x] Write tests for the new method (verify envelope wrapping, encryption call)
- [x] Run tests — must pass before next task

### Task 3: Convert Codex message handler to emit session-protocol events

Replace `sendCodexMessage()` calls in `runCodex.ts` with session-protocol event emission.

- [x] Add turn tracking state to `runCodex.ts`:
  - `currentTurnId: string | null` — set on `task_started`, cleared on `task_complete`/`turn_aborted`
  - Emit `turn-start` event on `task_started`
  - Emit `turn-end` event on `task_complete` / `turn_aborted`
- [x] Convert `agent_message` → `text` event with `turn` field
- [x] Convert `agent_reasoning` / `agent_reasoning_delta` → `text` event with `thinking: true`
- [x] Convert `exec_command_begin` / `exec_approval_request` → `tool-call-start` event
  - `call`: use `call_id` from MCP message
  - `name`: `CodexBash`
  - `title`: short summary from command
  - `description`: full command description
  - `args`: input params
- [x] Convert `exec_command_end` → `tool-call-end` event
- [x] Convert `patch_apply_begin` → `tool-call-start` with name `CodexPatch`
- [x] Convert `patch_apply_end` → `tool-call-end`
- [x] Convert `token_count` → skip (no session-protocol equivalent, or emit as-is using sendCodexMessage for backwards compat)
- [x] Keep `task_started`/`task_complete`/`turn_aborted` sending via session events (sendSessionEvent) — these are lifecycle, not messages
- [x] Write tests for the conversion logic (mock session, verify correct event types emitted)
- [x] Run tests — must pass before next task

### Task 4: Update ReasoningProcessor to emit session-protocol events

The `ReasoningProcessor` currently calls `session.sendCodexMessage()` directly via callback. Update it.

- [x] Update the callback type in `ReasoningProcessor` constructor to accept session-protocol envelopes
- [x] Convert reasoning tool-call emissions to `tool-call-start` / `tool-call-end` session-protocol events
- [x] Convert reasoning message emissions to `text` events with `thinking: true`
- [x] Write tests for the updated processor output format
- [x] Run tests — must pass before next task

### Task 5: Add session-protocol parsing to `typesRaw.ts` (app)

Add a new `type: 'session'` branch to the raw record schema and update `normalizeRawMessage()`.

- [x] Add Zod schema for the session-protocol envelope in `typesRaw.ts`:
  - `z.object({ type: z.literal('session'), data: sessionEnvelopeSchema })`
  - The envelope schema validates `id`, `time`, `role`, `turn?`, `invoke?`, `ev` with discriminated union on `ev.t`
- [x] Add `'session'` to `rawAgentRecordSchema` discriminated union
- [x] Add normalization logic in `normalizeRawMessage()` for `raw.content.type === 'session'`:
  - `ev.t === 'text'` → `NormalizedMessage` with `role: 'agent'`, content: `[{ type: 'text', text, uuid, parentUUID }]` (or `type: 'thinking'` if `ev.thinking`)
  - `ev.t === 'tool-call-start'` → `NormalizedMessage` with content: `[{ type: 'tool-call', id: ev.call, name: ev.name, input: ev.args, description: ev.description }]`
  - `ev.t === 'tool-call-end'` → `NormalizedMessage` with content: `[{ type: 'tool-result', tool_use_id: ev.call, content: null, is_error: false }]`
  - `ev.t === 'turn-start'` → `NormalizedMessage` with `role: 'event'`, content: `{ type: 'message', message: 'Turn started' }` (or skip)
  - `ev.t === 'turn-end'` → `NormalizedMessage` with `role: 'event'`, content: `{ type: 'ready' }` (triggers ready handling)
  - `ev.t === 'file'` → map to tool-call for display
  - `ev.t === 'photo'` → map to tool-call for display (or new message type later)
- [x] Handle `invoke` field: set `parentUUID` to the `invoke` value so sidechains work through existing tracer
- [x] Handle `turn` field: set `uuid` to `turn` value so grouping works
- [x] Write tests for each event type normalization (valid input → correct NormalizedMessage)
- [x] Write tests for invalid/malformed session events (graceful null return)
- [x] Run tests — must pass before next task

### Task 6: Update reducer for turn-start/turn-end awareness

The reducer already handles `NormalizedMessage` well. Minor updates for the new event semantics.

- [x] Ensure `turn-end` events with `{ type: 'ready' }` trigger `hasReadyEvent = true` (already works via existing code path)
- [x] Ensure `turn-start` events don't create visible messages (filter them out or make them no-op)
- [x] Ensure subagent messages (with `invoke` → `parentUUID`) flow through existing sidechain/tracer logic
- [x] Write tests verifying turn lifecycle events flow correctly through reducer
- [x] Write tests verifying subagent messages nest correctly under parent tool calls
- [x] Run tests — must pass before next task

### Task 7: Verify acceptance criteria

- [x] Verify Codex CLI emits session-protocol events for all message types
- [x] Verify app can parse and display session-protocol messages
- [x] Verify app still handles legacy formats (output, codex, acp) correctly
- [x] Verify subagent nesting works via invoke field
- [x] Verify turn lifecycle (turn-start/turn-end) works correctly
- [x] Run full test suite — `yarn test` in happy-cli, happy-app
- [x] Run linter — all issues must be fixed

### Task 8: [Final] Update documentation

- [x] Update `docs/session-protocol.md` if any deviations from spec were necessary
- [x] Add inline code comments for the session-protocol conversion path

## Technical Details

### Envelope structure (wire format)

```typescript
// What gets encrypted and sent over WebSocket
{
  role: 'agent',
  content: {
    type: 'session',  // NEW discriminator
    data: {           // session-protocol envelope
      id: 'cuid2...',
      time: 1739347200000,
      role: 'agent',
      turn: 'turn-id',
      invoke: 'parent-call-id',  // only for subagents
      ev: { t: 'text', text: 'Hello' }
    }
  },
  meta: { sentFrom: 'cli' }
}
```

### Event → NormalizedMessage mapping

| Session Protocol Event | NormalizedMessage role | NormalizedMessage content type |
|---|---|---|
| `text` | `agent` | `text` (or `thinking` if `ev.thinking`) |
| `tool-call-start` | `agent` | `tool-call` |
| `tool-call-end` | `agent` | `tool-result` |
| `turn-start` | `event` | `{ type: 'message', message: 'Turn started' }` |
| `turn-end` | `event` | `{ type: 'ready' }` |
| `file` | `agent` | `tool-call` (synthetic, for UI display) |
| `photo` | `agent` | `tool-call` (synthetic, for UI display) |

### Turn tracking in CLI

```
task_started → emit turn-start, set currentTurnId
  agent_message → emit text with turn: currentTurnId
  exec_command_begin → emit tool-call-start with turn: currentTurnId
  exec_command_end → emit tool-call-end with turn: currentTurnId
task_complete → emit turn-end, clear currentTurnId
```

## Post-Completion

**Manual verification:**
- Test with real Codex session to verify messages display correctly in app
- Verify existing Claude Code sessions still display correctly (legacy format)
- Test abort/resume flow with session-protocol format
- Test permission flow with session-protocol format
