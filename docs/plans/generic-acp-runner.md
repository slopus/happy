# Generic ACP Runner

## Overview

Create a clean, generic ACP agent runner that starts any ACP-compatible CLI from a command + args and communicates via ACP protocol. The runner maps ACP events to the new session protocol (envelopes) through a stateful handler class. No vendor-specific hacks. No credentials/env/API key resolution. No session restarts. No conversation history. Just: command in, session protocol out.

This enables support for Gemini, OpenCode, and any future ACP agent without writing per-agent runners.

## Context

- **Existing AcpBackend** (`agent/acp/AcpBackend.ts`) already handles process spawning, ACP JSON-RPC, permissions, and tool tracking. Reused as-is.
- **Existing runGemini.ts** (~1300 lines) is vendor-specific. Stays untouched; migration happens later.
- **Codex already uses new session protocol** via `mapCodexMcpMessageToSessionEnvelopes()` — reference pattern.
- **Session protocol types** in `@slopus/happy-wire` (`SessionEnvelope`, `createEnvelope()`).
- **AgentMessage** is the event type emitted by `AcpBackend.onMessage()`.
- The runner does NOT resolve credentials, API keys, OAuth tokens, or environment variables. The user's shell environment is inherited as-is. If `gemini` needs `GEMINI_API_KEY`, the user sets it before running.

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Testing Strategy
- **Unit tests**: Required for every task
- Test the stateful event mapper thoroughly (it's the core logic)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with + prefix
- Document issues/blockers with !! prefix

## Implementation Steps

### Task 1: Create AcpSessionMapper class

The stateful handler that maps `AgentMessage` events from `AcpBackend` into `SessionEnvelope[]` for the new session protocol. This is the core logic.

**File**: `packages/happy-cli/src/agent/acp/AcpSessionMapper.ts`

**Class design**:
```typescript
class AcpSessionMapper {
  private currentTurnId: string | null = null;

  // Called when agent emits a message. Returns envelopes to send.
  mapMessage(msg: AgentMessage): SessionEnvelope[]
}
```

**Mapping rules** (AgentMessage type -> SessionEnvelope events):
- `status: 'running'` (first time per turn) -> `turn-start` envelope (creates new turnId)
- `status: 'idle'` or `status: 'stopped'` (when turn is active) -> `turn-end { status: 'completed' }`
- `status: 'error'` (when turn is active) -> `turn-end { status: 'failed' }`
- `model-output { textDelta }` -> `text { text: textDelta }`
- `tool-call` -> `tool-call-start { call, name, title, description, args }`
- `tool-result` -> `tool-call-end { call }`
- `event { name: 'thinking' }` -> `text { text, thinking: true }`
- `permission-request`, `permission-response`, `token-count` -> ignored (handled elsewhere)

**Key behaviors**:
- Turn lifecycle: `running` starts a turn, `idle/stopped/error` ends it
- No turn nesting — only one turn active at a time
- Idempotent: multiple `running` statuses don't create multiple turns
- Multiple `idle` statuses don't create multiple `turn-end`s

**ID generation**:
- `turn` IDs: generated as cuid2 via `createId()` on `turn-start`
- `call` IDs in `tool-call-start` / `tool-call-end`: generated as cuid2, mapped from the ACP backend's `callId`
- Envelope `id` fields: generated as cuid2 via `createEnvelope()` (automatic)
- `subagent` IDs: cuid2 (future, not needed for v1)

Since all IDs are non-deterministic cuid2, tests must:
- Assert structural shape (correct `ev.t`, correct fields present)
- Assert ID consistency (same `turn` across all envelopes in a turn, same `call` in start/end pairs)
- Assert ID format (valid cuid2)
- NOT assert exact ID values

**Test file**: `packages/happy-cli/src/agent/acp/AcpSessionMapper.test.ts`

**Test cases for turn lifecycle**:
- `running` -> emits 1 envelope: `turn-start` with cuid2 `turn`
- `running` then `idle` -> emits `turn-start` then `turn-end { status: 'completed' }`, both share same `turn`
- `running` then `error` -> `turn-start` then `turn-end { status: 'failed' }`, same `turn`
- `running` then `stopped` -> `turn-start` then `turn-end { status: 'cancelled' }`, same `turn`
- `running, running` -> only 1 `turn-start` (idempotent)
- `idle` without prior `running` -> no envelopes (no turn to end)
- `idle, idle` -> only 1 `turn-end` (idempotent)
- `running, idle, running, idle` -> 2 complete turn cycles, each with different `turn` cuid2
- `starting` status -> ignored (no envelopes)

**Test cases for text mapping**:
- `model-output { textDelta }` during active turn -> `text { text }` envelope with correct `turn`
- `model-output` without active turn -> `text` envelope without `turn` (or auto-start turn — TBD)
- Empty `textDelta` -> no envelope

**Test cases for tool call mapping**:
- `tool-call { callId, toolName, args }` -> `tool-call-start { call, name, title, description, args }` with cuid2 `call`
- `tool-result { callId }` -> `tool-call-end { call }` where `call` matches the cuid2 mapped from same `callId`
- Multiple tool calls -> each gets distinct cuid2 `call`, correctly paired start/end
- `tool-result` for unknown `callId` -> still emits `tool-call-end` with new cuid2
- All tool envelopes carry the current `turn`

**Test cases for thinking**:
- `event { name: 'thinking', payload: { text } }` -> `text { text, thinking: true }` with current `turn`
- Thinking with empty text -> no envelope

**Test cases for ignored messages**:
- `permission-request` -> no envelopes
- `permission-response` -> no envelopes
- `token-count` -> no envelopes
- `fs-edit` -> no envelopes
- `terminal-output` -> no envelopes

**Test cases for ID consistency across a full sequence**:
- Simulate full turn: `running` -> `model-output` -> `tool-call` -> `tool-result` -> `model-output` -> `idle`
- Assert all envelopes share same `turn` cuid2
- Assert `tool-call-start.call` matches `tool-call-end.call`
- Assert all `id` fields are unique cuid2
- Assert `turn` changes between separate turns

- [ ] Create `AcpSessionMapper` class with `mapMessage()` method
- [ ] Implement turn lifecycle (turn-start on running, turn-end on idle/error)
- [ ] Implement text mapping (model-output -> text event)
- [ ] Implement tool call mapping (tool-call -> tool-call-start, tool-result -> tool-call-end) with cuid2 call ID mapping
- [ ] Implement thinking mapping (event/thinking -> text with thinking: true)
- [ ] Write tests for turn lifecycle (all cases above)
- [ ] Write tests for text/tool/thinking mapping (all cases above)
- [ ] Write tests for ignored messages
- [ ] Write tests for ID consistency across full turn sequence
- [ ] Write tests for edge cases (multiple idles, running without idle, etc.)
- [ ] Run tests - must pass before next task

### Task 2: Create generic runAcp runner function

The runner function that wires everything together: creates AcpBackend, listens for messages, maps them through AcpSessionMapper, and sends them to the session.

**File**: `packages/happy-cli/src/agent/acp/runAcp.ts`

**Signature**:
```typescript
async function runAcp(opts: {
  credentials: Credentials;
  agentName: string;       // e.g. 'gemini', 'opencode'
  command: string;         // e.g. 'gemini'
  args: string[];          // e.g. ['--experimental-acp']
  startedBy?: 'daemon' | 'terminal';
}): Promise<void>
```

**No credentials/env resolution** — the command is run with the user's inherited shell environment. No `GEMINI_API_KEY`, no OAuth tokens, no model resolution. The user sets their env before running.

**What it does** (simplified flow):
1. Create API session (same pattern as runGemini but simpler)
2. Start Happy MCP server for tool bridge
3. Create AcpBackend with DefaultTransport (no vendor-specific transport)
4. Create AcpSessionMapper
5. Wire: `backend.onMessage(msg => mapper.mapMessage(msg).forEach(env => session.sendSessionProtocolMessage(env)))`
6. Start ACP session
7. Listen for user messages from session, forward to backend via `sendPrompt()`
8. Handle abort/kill session
9. Simple console logging (no Ink)
10. Clean up on exit

- [ ] Create `runAcp()` function with session setup (API client, machine, session creation)
- [ ] Wire AcpBackend + AcpSessionMapper + session protocol message sending
- [ ] Implement user message handling (session.onUserMessage -> messageQueue -> sendPrompt)
- [ ] Implement abort/kill session handlers
- [ ] Implement permission handling via AcpPermissionHandler interface
- [ ] Add simple console logging for status (no Ink)
- [ ] Add cleanup/dispose logic
- [ ] Write tests for runner setup and message flow (with mocked backend)
- [ ] Run tests - must pass before next task

### Task 3: Register agents and add CLI commands

Wire the generic runner into the CLI so users can run `happy acp gemini` or `happy acp opencode` or `happy acp -- custom-agent --flag`.

**Files**:
- `packages/happy-cli/src/index.ts` — add CLI command routing
- Agent configs for known agents (command + args only, no env/credentials)

**Agent config**:
```typescript
const KNOWN_ACP_AGENTS: Record<string, { command: string; args: string[] }> = {
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
  opencode: { command: 'opencode', args: ['--acp'] },
};
```

No env vars, no API keys, no model config. Just command + args.

- [ ] Define known ACP agent configs (command + args only)
- [ ] Add CLI routing for `happy acp <agent-name>` and `happy acp -- <cmd> [args]`
- [ ] Wire to `runAcp()` with resolved config
- [ ] Write tests for agent config resolution
- [ ] Run tests - must pass before next task

### Task 4: Verify acceptance criteria
- [ ] Verify generic runner works without vendor-specific code
- [ ] Verify no credentials/env/API key resolution anywhere in the new code
- [ ] Verify new session protocol envelopes are emitted correctly
- [ ] Verify sessions are never restarted (only in-memory state)
- [ ] Verify permission handling works
- [ ] Run full test suite (unit tests)
- [ ] Run linter - all issues must be fixed

### Task 5: [Final] Update documentation
- [ ] Update README.md if needed
- [ ] Add inline comments explaining the architecture

## Technical Details

### AcpSessionMapper State Machine

```
[no turn] ---(status: running)---> [turn active]
[turn active] ---(status: idle)---> [no turn]  (emit turn-end: completed)
[turn active] ---(status: error)---> [no turn]  (emit turn-end: failed)
[turn active] ---(status: stopped)---> [no turn] (emit turn-end: cancelled)
```

All content events (text, tool-call-start, tool-call-end, thinking) are emitted with the current `turnId` set on the envelope.

### No Credentials / No Env Resolution

The runner inherits the user's shell environment. Period. If the agent needs `GEMINI_API_KEY` or `OPENAI_API_KEY`, the user sets it in their shell. The runner doesn't know or care about vendor-specific env vars.

### No Session Restarts

The ACP protocol supports model switching natively. The process stays alive for the entire CLI session. No dispose-and-recreate. No conversation history injection.

### DefaultTransport

The generic runner uses `DefaultTransport` which:
- 60s init timeout
- Filters non-JSON stdout lines
- No stderr error detection
- No tool name extraction hacks

If a specific agent needs custom transport behavior, it can be added later — but the runner stays generic.

## Post-Completion

**Manual verification:**
- Test with `gemini --experimental-acp` to verify ACP protocol works
- Test with `opencode --acp` when available
- Verify mobile app receives session protocol envelopes correctly

**Future work:**
- Migrate `runGemini.ts` to use generic runner as thin wrapper
- Add agent-specific transport handlers only when proven necessary
