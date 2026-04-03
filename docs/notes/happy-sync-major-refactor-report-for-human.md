# happy-sync Data Flow Report

How data flows from provider SDK → screen, with concrete examples.

Written March 24, 2026, based on the `happy-sync-refactor` branch.

---

## Pipeline Overview

```
Claude SDK (RawJSONLines)
  ↓ handleClaudeMessage()        — v3Mapper.ts
v3.MessageWithParts               — THE canonical shape
  ↓ session.sendV3Message()       — session.ts
  ↓ syncBridge.sendMessage()      — syncBridge.ts
  ↓ SyncNode.sendMessage()        — encrypts, HTTP POST
  ↓ POST /v3/sessions/:id/messages — v3SessionRoutes.ts (upsert + broadcast)
  ↓ eventRouter.emitUpdate()      — WebSocket push
  ↓ App SyncNode receives         — decrypts back to MessageWithParts
  ↓ subscribe → applyV3Messages() — copies into Zustand (TO BE ELIMINATED)
  ↓ React re-render               — reads from Zustand, renders parts
```

Zero schema conversions between mapper output and screen render. The
`MessageWithParts` created in `v3Mapper.ts` is the exact same shape that
React components consume. The only transformations are encrypt/decrypt
(transparent) and the Zustand copy (which should be eliminated — see
design amendments in `docs/plans/happy-sync-major-refactor.md`).

---

## Flow 1: Normal tool call (e.g., `Read` tool)

### Stage 1: Claude SDK emits `RawJSONLines`

The SDK sends cumulative assistant snapshots via `stream-json`. Each message
is a complete snapshot of the current turn.

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet-4-20250514",
    "content": [
      { "type": "text", "text": "Let me read that file." },
      { "type": "tool_use", "id": "toolu_01ABC", "name": "Read",
        "input": { "file_path": "/app.js" } }
    ],
    "usage": { "input_tokens": 500, "output_tokens": 120 }
  }
}
```

### Stage 2: `session.ts:132` — `sendClaudeMessage(body)`

```typescript
// session.ts:140
const result = handleClaudeMessage(body, this.v3MapperState);
// result.messages = []  (turn not finished yet — no user msg arrived)
// result.currentAssistant = the in-flight MessageWithParts (below)
```

### Stage 3: `v3Mapper.ts:241` — `handleAssistantMessage()`

First call creates the assistant message shell (line 261-284), then processes
content blocks:

```typescript
// Text block → TextPart (line 297-307)
{ id: "prt_abc1", sessionID: "sess_123", messageID: "msg_xyz",
  type: "text", text: "Let me read that file.", time: { start: 1711300000000 } }

// tool_use block → ToolPart (line 323-357)
{ id: "prt_abc2", sessionID: "sess_123", messageID: "msg_xyz",
  type: "tool", callID: "toolu_01ABC", tool: "Read",
  state: {
    status: "running",
    input: { file_path: "/app.js" },
    title: "Read call",
    time: { start: 1711300000000 }
  }
}
```

The full in-flight `MessageWithParts`:

```typescript
{
  info: {
    id: "msg_xyz", sessionID: "sess_123", role: "assistant",
    time: { created: 1711300000000 },
    parentID: "msg_user1", modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic", agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0, tokens: { input: 500, output: 120, reasoning: 0,
      cache: { read: 0, write: 0 } }
  },
  parts: [
    { type: "step-start", ... },
    { type: "text", text: "Let me read that file.", ... },
    { type: "tool", callID: "toolu_01ABC", tool: "Read",
      state: { status: "running", ... } }
  ]
}
```

### Stage 4: `session.ts:147` — `updateV3Message()` → SyncBridge

```typescript
this.updateV3Message(result.currentAssistant);
// → syncBridge.updateMessage(message)
// → this.node.updateMessage(this.sessionId, message)
```

### Stage 5: SyncNode encrypts + HTTP POST

```
POST /v3/sessions/sess_123/messages
Body: { messages: [{ content: "<base64-encrypted-MessageWithParts>",
                     localId: "msg_xyz" }] }
```

The `localId` is the message ID — used for upsert dedup.

### Stage 6: Server `v3SessionRoutes.ts:107` — POST handler

1. **Dedup** (line 136-139): Same `localId` in batch → keep last (last-write-wins)
2. **Upsert** (line 144-245):
   - First time: `sessionMessage.create()` with `seq` from `allocateSessionSeqBatch()`
   - Updates: `sessionMessage.update()` by `(sessionId, localId)` composite key
   - Content stored as: `{ t: "encrypted", c: "<base64>" }`
3. **Broadcast** (line 247-266):
   ```typescript
   eventRouter.emitUpdate({
     userId,
     payload: buildNewMessageUpdate(...),
     recipientFilter: { type: 'all-interested-in-session', sessionId }
   });
   ```

### Stage 7: App SyncNode receives WebSocket update

Decrypts back to `MessageWithParts`, updates `SyncState`:

```typescript
SyncState.sessions.get("sess_123").messages  // now contains the message
```

### Stage 8: Zustand subscription

```typescript
// sync.ts:~183-187
this.appSyncStore.subscribe((state) => {
    for (const [sessionId, sessionState] of state.sessions) {
        storage.getState().applyV3Messages(sessionId, sessionState.messages);
    }
});
```

### Stage 9: React re-renders

- Text: "Let me read that file."
- Tool: **Read** `/app.js` — status label **"Running"**

### Stage 10: Tool completes — SDK sends `tool_result`

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01ABC",
        "content": "1: const app = ...\n2: ...",
        "is_error": false }
    ]
  }
}
```

### Stage 11: v3Mapper processes tool_result FIRST (line 162-201)

```typescript
toolPart.state = {
    status: "completed",
    input: { file_path: "/app.js" },
    output: "1: const app = ...\n2: ...",
    title: "Read call",
    time: { start: 1711300000000, end: 1711300001500 }
};
```

### Stage 12: `finalizeAssistantMessage()` (line 378-414)

Adds `step-finish` part, pushes to `result.messages`. Goes through same
pipeline → app shows tool as **"Completed"** with output.

---

## Flow 2: Permission request → approve → tool completes

### Stage A: Claude SDK emits `tool_use` for `Edit`

v3Mapper creates ToolPart with `status: "running"` (same as Flow 1).

### Stage B: `permissionHandler.ts:128` — `handleToolCall()` fires

The Claude SDK calls `canCallTool` callback. The handler:

1. Resolves `(toolName, input)` → SDK `tool_use_id` (e.g., `"toolu_02XYZ"`)
2. Creates a Promise that **blocks the SDK** until resolved

### Stage C: `permissionHandler.ts:248` → `session.blockToolForPermission()`

```typescript
this.session.blockToolForPermission(
    "toolu_02XYZ",    // callID
    "Edit",           // permission (tool name)
    ["/app.js"],      // patterns
    { file_path: "/app.js", old_string: "...", new_string: "..." }
);
```

### Stage D: v3Mapper tool state transition

```typescript
// v3Mapper.ts:444-458
toolPart.state = {
    status: "blocked",
    input: { file_path: "/app.js", ... },
    title: "Edit call",
    time: { start: 1711300000000 },
    block: {
        type: "permission",
        id: "toolu_02XYZ",
        permission: "Edit",
        patterns: ["/app.js"],
        always: ["*"],
        metadata: { file_path: "/app.js", ... }
    }
};
```

**Race condition handling**: If the permission callback fires BEFORE the SDK
emits the `tool_use` block (ToolPart doesn't exist yet), `session.ts:184`
**enqueues** the transition and replays it on the next `sendClaudeMessage()`.

### Stage E: App renders blocked state

- Tool: **Edit** `/app.js` — status **"Awaiting approval"**
- Buttons: "Yes", "Yes, don't ask again for this tool", "No, and provide feedback"

### Stage F: User taps "Yes, don't ask again" in the app

App sends a `DecisionPart`:

```typescript
{ type: "decision", permissionID: "toolu_02XYZ",
  decision: "always", allowTools: ["Edit"] }
```

### Stage G: CLI SyncBridge receives, dispatches to callbacks

```typescript
// syncBridge.ts:83-91
cb({ permissionId: "toolu_02XYZ", decision: "always", allowTools: ["Edit"] });
```

### Stage H: permissionHandler notifies v3 mapper + resolves SDK promise

```typescript
// Notify v3 mapper
this.session.unblockToolApproved("toolu_02XYZ", "always");

// Resolve the SDK promise — Claude can proceed
pending.resolve({ behavior: 'allow', updatedInput: { ... } });
```

### Stage I: v3Mapper unblocks tool

```typescript
// v3Mapper.ts:478-494
toolPart.state = {
    status: "running",  // ← back to running
    input: { file_path: "/app.js", ... },
    title: "Edit call",
    time: { start: 1711300000000 },
};
// Stash resolved block for later:
(toolPart as any)._resolvedBlock = {
    type: "permission", permission: "Edit",
    decision: "always",
    decidedAt: 1711300005000
};
```

### Stage J: Tool executes, SDK sends `tool_result`

Same as Flow 1. The completed state includes the resolved block:

```typescript
toolPart.state = {
    status: "completed",
    output: "File edited successfully",
    time: { start: 1711300000000, end: 1711300006000 },
    block: {
        type: "permission", permission: "Edit",
        decision: "always", decidedAt: 1711300005000
    }
};
```

App shows: **"Completed"** with decision badge.

---

## Flow 3: Permission denied

Same as Flow 2 through Stage E, then:

App sends: `{ type: "decision", decision: "reject", reason: "Show me the diff" }`

v3Mapper:

```typescript
toolPart.state = {
    status: "error",
    error: "Show me the diff",
    time: { start: 1711300000000, end: 1711300005000 },
    block: { ..., decision: "reject", decidedAt: 1711300005000 }
};
```

SDK side: `pending.resolve({ behavior: 'deny', message: "Show me the diff" })`

App shows: **"Error"** with rejection reason.

---

## Flow 4: Model change

Model change is NOT a separate message type — it's metadata piggybacking on
the next user message.

### Stage 1: App sends user message with `meta.model`

```typescript
{
  info: {
    id: "msg_user42", role: "user",
    meta: { model: "claude-opus-4-20250514" }
  },
  parts: [{ type: "text", text: "Now rewrite the tests." }]
}
```

### Stage 2: CLI extracts meta, updates local state

```typescript
// runClaude.ts:356-358 — NOTE: cast through `as any`
const meta = (message.info as any).meta;
if (meta?.hasOwnProperty?.('model')) {
    currentModel = meta.model || undefined;
}
```

### Stage 3: MessageQueue2 detects mode hash change

The queue hashes `{ model, permissionMode, ... }`. New model → different hash.

### Stage 4: SDK session killed, restarted with new model

`claudeRemoteLauncher.ts:358` detects hash mismatch → returns `null` to
`claudeRemote()` → SDK exits → outer loop restarts with new model flag +
`--resume` to continue conversation.

**Key point**: Model change = kill current SDK process, restart with new
model flag. The v3Mapper just gets a new stream from the new process.
Subsequent assistant messages have the updated `modelID`.

**Known issue**: The `meta` field is not part of the v3 schema — it's an
`as any` cast. The model switch is invisible in the v3 transcript.

---

## Flow 5: Abort/Stop session

### Stage 1: App sends stop → RPC `abort` reaches CLI

`session.rpcHandlerManager.registerHandler('abort', doAbort)` at
`claudeRemoteLauncher.ts:95`

### Stage 2: AbortController fires

```typescript
async function abort() {
    if (abortController && !abortController.signal.aborted) {
        abortController.abort();  // signals the SDK
    }
    await abortFuture?.promise;
}
```

### Stage 3: SDK catches abort, throws AbortError

```typescript
// claudeRemote.ts:232-238
} catch (e) {
    if (e instanceof AbortError) {
        // silently ignore
    }
}
```

### Stage 4: Flush partial turn

```typescript
// claudeRemoteLauncher.ts:408-409
if (abortController.signal.aborted) {
    session.closeClaudeTurn('cancelled');
    // → flushV3Turn() finalizes in-flight assistant with step-finish
}
```

**Known issue**: Abort is a side-channel (RPC + process kill), not a v3
message. Tools may be left in `running` state. The app can't distinguish
"session crashed" from "user stopped".

---

## Side-channels that bypass v3 (to be fixed)

These are being redesigned as **flat, top-level control messages** in the
session stream — siblings of `MessageWithParts`, not nested inside them.
See `docs/plans/happy-sync-major-refactor.md` § "Design Amendments" for the
target schemas (`RuntimeConfigChange`, `AbortRequest`, `SessionEnd`).

| Channel | How it works now | Target |
|---|---|---|
| **Abort** | RPC → AbortController → kill process | `AbortRequest` control message |
| **Model/mode change** | `meta` on user message (`as any` cast) | `RuntimeConfigChange` control message |
| **Agent state** | Separate encrypted blob via socket | Remove — v3 tool parts are authoritative |
| **Session metadata** | Separate encrypted blob via socket | Consolidate into `SessionState` cache |
| **Keep alive** | Socket heartbeat every 2s | Fine — ephemeral presence, stays as-is |
| **Push notifications** | Direct push for permissions/ready | Fine — notification channel, stays as-is |
| **RPC handlers** | bash, readFile, writeFile, etc. | Fine — direct machine access, not conversation |
| **Usage data** | Separate SyncNode report | Remove — use v3 message info, cache on session state |
| **Session death** | Separate SyncNode signal | `SessionEnd` control message |

---

## Key files

| File | Role |
|---|---|
| `happy-cli/src/claude/utils/v3Mapper.ts` | RawJSONLines → MessageWithParts |
| `happy-cli/src/claude/session.ts` | Owns v3MapperState, routes to SyncBridge |
| `happy-cli/src/claude/utils/permissionHandler.ts` | Blocks SDK, dispatches decisions |
| `happy-cli/src/api/syncBridge.ts` | Wraps SyncNode for CLI session processes |
| `happy-cli/src/claude/claudeRemoteLauncher.ts` | Outer loop: message queue, abort, mode changes |
| `happy-cli/src/claude/claudeRemote.ts` | Inner loop: SDK invocation, event iteration |
| `happy-cli/src/claude/runClaude.ts` | Entry point: SyncBridge setup, user message routing |
| `happy-server/.../v3SessionRoutes.ts` | Server: upsert encrypted blobs, broadcast |
| `happy-sync/src/sync-node.ts` | SyncNode: encrypt, send, receive, state |
| `happy-app/sources/sync/storage.ts` | Zustand store (currently copies from SyncNode) |
| `happy-app/sources/sync/sync.ts` | App subscribe callback (the copy) |
