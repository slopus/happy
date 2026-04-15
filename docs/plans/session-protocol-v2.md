# Session Protocol v2 Design

Status: **DRAFT — under review**

## Context

The current session protocol (`happy-wire/src/sessionProtocol.ts`) was designed to solve a real problem: three different message formats (`output`, `codex`, `acp`) hitting the app, each with different field names and tool call shapes. The v1 protocol unified them into a flat event stream with 7 event types, normalized once in the CLI.

**What v1 got right:**
- Flat event stream — no nesting, single `switch` in the client
- Provider-agnostic — no agent backend leaks into the protocol
- Upload-first media with thumbhash for instant image placeholders
- `invoke` field for subagent tracking (flat stream, grouped by client)
- Turn lifecycle (`turn-start` / `turn-end`)
- Separation of lifecycle events from content events

**What v1 got wrong:**
- Single-letter field names (`t`, `ev`, `call`) — hard to read for humans and AI, negligible bandwidth savings under encryption
- No permissions in the protocol — permissions use a separate agent state + RPC side-channel, invisible in the chat transcript
- `role: "session"` wrapper around inner `role: "user" | "agent"` — unnecessary indirection
- Nested `ev` object — adds a level of nesting for no benefit

**What v1 was missing:**
- Permission request/response as first-class messages (audit trail)
- Parent tracking for nested tool calls (beyond subagents)
- Message consumption / read receipts

Before investing more, we researched the protocol landscape.

## Protocol Landscape (March 2026)

### Relevant protocols

| Protocol | Wire Format | Scope | Permissions | Our relevance |
|---|---|---|---|---|
| **ACP (Zed/JetBrains)** | JSON-RPC 2.0 / stdio | Editor <-> Coding Agent | First-class `request_permission` | **HIGH** — closest to our use case |
| **Pi RPC (pi.dev)** | Custom JSONL / stdin | Host <-> Agent | Extension UI sub-protocol | **MEDIUM** — good immutable stream design |
| **MCP (Anthropic)** | JSON-RPC 2.0 | Host <-> Tool Server | Guidelines only | **LOW** — different layer (tools, not sessions) |
| **A2A v1.0 (Google)** | Protobuf / JSON-RPC+gRPC+HTTP | Agent <-> Agent | `INPUT_REQUIRED` / `AUTH_REQUIRED` states | **LOW** — agent-to-agent, not UI-to-agent |
| **AGNTCY ACP** | REST / OpenAPI | Client <-> Remote Agent | Interrupt/resume mechanism | **LOW** — REST-oriented, LangGraph-specific |

### Key takeaway

These protocols are **complementary layers**, not competitors:
- **MCP** = app-to-tool
- **ACP (Zed)** = editor-to-agent
- **A2A** = agent-to-agent

Happy sits in the **ACP layer** — we're a remote UI controlling coding agents. Zed's ACP is the closest match, but we have unique constraints (remote/encrypted transport, multiple agent backends, mobile UI).

### What we take from each

**From ACP (Zed):** Permission kinds (`allow-once`, `allow-always`, `reject-once`, `reject-always`). Tool call status tracking vocabulary. Session lifecycle patterns.

**From Pi (pi.dev):** Immutable append-only event stream. Separate start/end events (not mutable status updates). Clear distinction between LLM deciding to call a tool vs the tool actually executing.

**From v1 (our own):** Flat stream with `turn` grouping. Parent tracking via a field on each message. Upload-first media with thumbhash. The 7-event-type simplicity target.

## Design Principles

1. **Immutable append-only stream** — messages are never updated, only appended. Start/end are separate events. (Inspired by Pi)
2. **Human-readable field names** — no abbreviations (`type` not `t`, `callId` not `call`, `toolName` not `name`)
3. **Debuggable** — a developer reading raw JSON should immediately understand what each message is
4. **Flat discriminated unions** — `type` field at the top level, not nested `ev.t`
5. **Permissions in the stream** — permission requests and responses are messages like anything else, creating a permanent audit trail
6. **Parent tracking** — any message can carry a `parentId` linking it to the tool call that spawned it, supporting subagents, nested tool calls, and future scripted pipelines
7. **Not married to any protocol** — we borrow concepts, not wire formats
8. **Encryption boundary unchanged** — server sees `{ c: "...", t: "encrypted" }`, inner format is our concern

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Server (transport)                                   │
│   Sees: { c: "<encrypted>", t: "encrypted" }        │
│   Unchanged — stores/relays opaque blobs             │
└─────────────────────────────────────────────────────┘
                        │
                   decrypt/encrypt
                        │
┌─────────────────────────────────────────────────────┐
│ Inner envelope (this spec)                           │
│   { role, type, ... }                                │
│   Human-readable, immutable, append-only             │
└─────────────────────────────────────────────────────┘
                        │
                   CLI mappers
                        │
┌─────────────────────────────────────────────────────┐
│ Provider output (Claude SDK, Codex MCP, ACP, etc.)   │
│   Each provider has its own format                   │
│   Mappers convert to our inner envelope              │
└─────────────────────────────────────────────────────┘
```

## Message Format

Every message is a JSON object with these common fields:

```typescript
type BaseMessage = {
  id: string;            // unique message id (cuid2)
  time: number;          // unix timestamp ms
  role: "user" | "agent";
  type: string;          // discriminator — the event type
  turn?: string;         // turn id (required for agent messages during a turn)
  parentId?: string;     // parent tool call id — for nesting (subagents, nested tools, pipelines)
  agentId?: string;      // subagent identity — stable id for the subagent producing this message
};
```

### `parentId` — hierarchical nesting

Any message can carry `parentId` pointing to the `callId` of the tool call that spawned it. This replaces v1's `invoke` field.

Use cases:
- **Subagent messages**: a `Task` tool call spawns a subagent → all subagent messages carry `parentId: "<task call id>"`
- **Nested tool calls**: a subagent's tool calls carry `parentId` pointing to their parent tool call
- **Scripted pipelines**: step B runs inside step A → step B's messages carry `parentId: "<step A call id>"`

Nesting can be arbitrarily deep. Clients group/indent by walking the `parentId` chain.

### `agentId` — subagent identity

Subagents have their own identity beyond just being children of a tool call. When a tool call spawns a subagent, the subagent's messages carry both `parentId` (which tool call spawned it) and `agentId` (the subagent's own stable identifier).

This matters because:
- A subagent may produce messages across multiple tool calls within the same turn
- The client needs to attribute work to a specific subagent for display (title, collapse state, etc.)
- Future: subagent metadata (name, type, session id) can be looked up by `agentId`

**How this differs from the current system:** The current protocol uses `subagent` as a cuid2 grouping id that the CLI mapper generates. It has no richer identity — no name, no type, no metadata. The v2 `agentId` serves the same grouping purpose but is named to clearly indicate it identifies an agent, not just a parent relationship.

**How ACP (Zed) handles this:** ACP has no subagent concept — it's a single-agent protocol. Tool calls are flat.

**How Pi handles this:** Pi has no subagent concept either. Single agent.

**How A2A handles this:** A2A delegates to other agents via `SendMessage` creating child tasks with `reference_task_ids`. Agents have identity via Agent Cards. This is the closest parallel — but at a much heavier weight.

**Our approach:** Keep it lightweight. `agentId` is a string identifier. The CLI mapper generates it when a subagent is detected. Optional `agentTitle` on `tool-call-start` provides a human-readable label when the tool call spawns a subagent.

---

## Event Types

### 11 event types — one `switch(type)` in the client

| Type | Role | Purpose |
|---|---|---|
| `turn-start` | agent | Agent begins processing |
| `turn-end` | agent | Agent finishes processing |
| `text` | agent or user | Text content (markdown, thinking) |
| `tool-call-start` | agent | Agent begins a tool invocation |
| `tool-call-end` | agent | Tool invocation completes |
| `permission-request` | agent | Agent asks user for approval |
| `permission-response` | user | User responds to permission request |
| `photo` | agent or user | Image with thumbhash for instant placeholder |
| `video` | agent or user | Video with thumbhash + dimensions + duration |
| `file` | agent or user | Generic file attachment by reference |
| `service` | agent | Internal/system messages |

---

### `turn-start`

Marks the beginning of an agent turn (one prompt → response cycle).

```json
{
  "id": "msg_abc123",
  "time": 1710000000000,
  "role": "agent",
  "type": "turn-start",
  "turn": "turn_xyz789"
}
```

### `turn-end`

Marks the end of an agent turn.

```json
{
  "id": "msg_abc124",
  "time": 1710000010000,
  "role": "agent",
  "type": "turn-end",
  "turn": "turn_xyz789",
  "status": "completed"
}
```

`status`: `"completed"` | `"failed"` | `"cancelled"`

### `text`

Text content. Works for both user prompts and agent output.

```json
{
  "id": "msg_abc125",
  "time": 1710000000100,
  "role": "agent",
  "type": "text",
  "turn": "turn_xyz789",
  "text": "I'll help you fix that bug.",
  "thinking": false
}
```

`thinking`: `true` for reasoning/thinking tokens, `false` or omitted for visible output. User messages never set `thinking`.

### `tool-call-start`

Agent begins a tool invocation. This is the LLM's decision to invoke a tool — execution may not start until after permission is granted.

```json
{
  "id": "msg_abc126",
  "time": 1710000000200,
  "role": "agent",
  "type": "tool-call-start",
  "turn": "turn_xyz789",
  "callId": "call_001",
  "toolName": "bash",
  "title": "Run `ls -la`",
  "description": "List files in current directory",
  "args": { "command": "ls -la" }
}
```

| Field | Type | Description |
|---|---|---|
| `callId` | string | Unique tool call identifier, matched by `tool-call-end` |
| `toolName` | string | Tool name (e.g. `bash`, `edit`, `grep`) |
| `title` | string | Short human-readable summary (inline markdown) |
| `description` | string | Longer description (inline markdown) |
| `args` | object | Tool input arguments |

### `tool-call-end`

Tool invocation completes. Matches a prior `tool-call-start` by `callId`.

```json
{
  "id": "msg_abc127",
  "time": 1710000000500,
  "role": "agent",
  "type": "tool-call-end",
  "turn": "turn_xyz789",
  "callId": "call_001"
}
```

Optionally carries an `error` field on failure:

```json
{
  "id": "msg_abc127",
  "time": 1710000000500,
  "role": "agent",
  "type": "tool-call-end",
  "turn": "turn_xyz789",
  "callId": "call_001",
  "error": "Command exited with code 1"
}
```

### `permission-request`

Agent requests permission to proceed with a tool call. This goes into the message stream (not a side-channel), creating a permanent audit trail. Modeled after ACP's `session/request_permission`.

```json
{
  "id": "msg_abc128",
  "time": 1710000000300,
  "role": "agent",
  "type": "permission-request",
  "turn": "turn_xyz789",
  "callId": "call_001",
  "toolName": "bash",
  "title": "Run `rm -rf node_modules`",
  "description": "Delete node_modules directory",
  "args": { "command": "rm -rf node_modules" },
  "options": [
    { "id": "allow-once", "label": "Allow once", "kind": "allow-once" },
    { "id": "allow-session", "label": "Allow for session", "kind": "allow-always" },
    { "id": "deny", "label": "Deny", "kind": "reject-once" },
    { "id": "deny-always", "label": "Always deny", "kind": "reject-always" }
  ]
}
```

Permission kinds (from ACP): `"allow-once"` | `"allow-always"` | `"reject-once"` | `"reject-always"`

**Timing**: A `permission-request` appears in the stream between `tool-call-start` and `tool-call-end`. The tool does not execute until the user responds.

### `permission-response`

User responds to a permission request.

```json
{
  "id": "msg_user002",
  "time": 1710000000400,
  "role": "user",
  "type": "permission-response",
  "callId": "call_001",
  "optionId": "allow-once"
}
```

### `photo`

Image attachment. The image must be uploaded/encrypted first, then referenced. Includes thumbhash for instant placeholder rendering (from v1 design).

```json
{
  "id": "msg_abc132",
  "time": 1710000000600,
  "role": "user",
  "type": "photo",
  "ref": "media/upload_abc123",
  "thumbhash": "3OcRJYB4d3h/iIeHeEh3eIhw+j2w",
  "width": 1920,
  "height": 1080
}
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload/media reference ID |
| `thumbhash` | string | Base64-encoded [ThumbHash](https://evanw.github.io/thumbhash/) for instant placeholder |
| `width` | number | Original width in pixels |
| `height` | number | Original height in pixels |

### `video`

Video attachment. The video must be uploaded/encrypted first, then referenced. Includes thumbhash for instant poster frame rendering. See `docs/plans/encrypted-media-v1.md` for the full media pipeline design.

```json
{
  "id": "msg_abc134",
  "time": 1710000000800,
  "role": "agent",
  "type": "video",
  "turn": "turn_xyz789",
  "ref": "media/upload_vid789",
  "thumbhash": "3OcRJYB4d3h/iIeHeEh3eIhw+j2w",
  "width": 1920,
  "height": 1080,
  "durationMs": 45000,
  "mimeType": "video/mp4",
  "size": 104857600
}
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload/media reference ID |
| `thumbhash` | string | Base64-encoded [ThumbHash](https://evanw.github.io/thumbhash/) for poster frame placeholder |
| `width` | number | Video width in pixels |
| `height` | number | Video height in pixels |
| `durationMs` | number | Video duration in milliseconds |
| `mimeType` | string | MIME type (e.g. `video/mp4`) |
| `size` | number | File size in bytes |

**V1 playback model**: download entire encrypted blob, decrypt locally, write to temp file, hand to native player. See encrypted-media-v1.md for benchmarks and V2 streaming considerations.

### `file`

Generic file attachment. The file must be uploaded/encrypted first, then referenced. Use `photo` or `video` for media with visual preview support.

```json
{
  "id": "msg_abc133",
  "time": 1710000000700,
  "role": "agent",
  "type": "file",
  "turn": "turn_xyz789",
  "ref": "media/upload_def456",
  "name": "report.pdf",
  "size": 104857600,
  "mimeType": "application/pdf"
}
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload/media reference ID |
| `name` | string | Display filename |
| `size` | number | File size in bytes |
| `mimeType` | string | MIME type |

### `service`

Internal/system messages (not directly from the LLM). Context compaction, session metadata, etc.

```json
{
  "id": "msg_abc131",
  "time": 1710000000050,
  "role": "agent",
  "type": "service",
  "turn": "turn_xyz789",
  "text": "Context window compacted"
}
```

---

## Example Streams

### Simple tool call

```
← { id: "a1", time: 1000, role: "user",  type: "text", text: "Find TODOs" }
← { id: "a2", time: 1001, role: "agent", type: "turn-start", turn: "t1" }
← { id: "a3", time: 1002, role: "agent", type: "text", turn: "t1", text: "Searching...", thinking: false }
← { id: "a4", time: 1003, role: "agent", type: "tool-call-start", turn: "t1", callId: "c1", toolName: "grep", title: "Searching for TODO", description: "Searching for `TODO` in project root", args: { "pattern": "TODO" } }
← { id: "a5", time: 1004, role: "agent", type: "tool-call-end", turn: "t1", callId: "c1" }
← { id: "a6", time: 1005, role: "agent", type: "text", turn: "t1", text: "Found 3 TODOs." }
← { id: "a7", time: 1006, role: "agent", type: "turn-end", turn: "t1", status: "completed" }
```

### Tool call with permission

```
← { id: "b1", time: 2000, role: "user",  type: "text", text: "Delete node_modules" }
← { id: "b2", time: 2001, role: "agent", type: "turn-start", turn: "t2" }
← { id: "b3", time: 2002, role: "agent", type: "tool-call-start", turn: "t2", callId: "c2", toolName: "bash", title: "Run `rm -rf node_modules`", description: "Delete node_modules directory", args: { "command": "rm -rf node_modules" } }
← { id: "b4", time: 2003, role: "agent", type: "permission-request", turn: "t2", callId: "c2", toolName: "bash", title: "Run `rm -rf node_modules`", args: { "command": "rm -rf node_modules" }, options: [...] }
← { id: "b5", time: 2010, role: "user",  type: "permission-response", callId: "c2", optionId: "allow-once" }
← { id: "b6", time: 2011, role: "agent", type: "tool-call-end", turn: "t2", callId: "c2" }
← { id: "b7", time: 2012, role: "agent", type: "text", turn: "t2", text: "Done. Deleted node_modules." }
← { id: "b8", time: 2013, role: "agent", type: "turn-end", turn: "t2", status: "completed" }
```

### Subagent (nested via parentId + agentId)

```
← { id: "c1", time: 3000, role: "agent", type: "tool-call-start", turn: "t1", callId: "task1", toolName: "task", title: "Exploring codebase", description: "Searching for auth implementations", args: { "prompt": "Find auth code" }, agentTitle: "Auth research" }
← { id: "c2", time: 3001, role: "agent", type: "text", turn: "t1", parentId: "task1", agentId: "agent_sub1", text: "Looking at src/auth/..." }
← { id: "c3", time: 3002, role: "agent", type: "tool-call-start", turn: "t1", parentId: "task1", agentId: "agent_sub1", callId: "c3", toolName: "grep", title: "Searching for login", description: "Searching for `login` in src/auth/", args: { "pattern": "login" } }
← { id: "c4", time: 3003, role: "agent", type: "tool-call-end", turn: "t1", parentId: "task1", agentId: "agent_sub1", callId: "c3" }
← { id: "c5", time: 3004, role: "agent", type: "text", turn: "t1", parentId: "task1", agentId: "agent_sub1", text: "Found auth handler." }
← { id: "c6", time: 3005, role: "agent", type: "tool-call-end", turn: "t1", callId: "task1" }
```

- `parentId: "task1"` — these messages are children of the `task1` tool call (nesting)
- `agentId: "agent_sub1"` — these messages come from a specific subagent (identity)
- `agentTitle: "Auth research"` on the `tool-call-start` — human-readable label for the subagent when it spawns
- The `tool-call-end` for `task1` has no `agentId` — it's the parent agent closing the tool call

Nesting can go deeper — a subagent's tool call can itself spawn another subagent with its own `agentId`.

### User sends a photo

```
← { id: "d1", time: 4000, role: "user", type: "photo", ref: "media/up_1", thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j2w", width: 800, height: 600 }
← { id: "d2", time: 4001, role: "user", type: "text", text: "What's in this screenshot?" }
```

---

## How Permissions Change

### Current system (v0 — side-channel)

```
agent needs permission
  → updateAgentState(requests[id])     ← ephemeral side-channel, not in transcript
  → push notification to phone
  → user taps approve in app
  → app sends RPC('permission', {...}) ← separate encrypted RPC, not in transcript
  → CLI resolves pending promise
  → updateAgentState(completedRequests[id])
```

**Problem**: permissions are invisible in the chat. You can't scroll back and see what was approved/denied and when.

### New system (v2 — in the stream)

```
agent needs permission
  → tool-call-start emitted to stream
  → permission-request emitted to stream    ← visible, permanent record
  → push notification to phone
  → user taps approve in app
  → permission-response emitted to stream   ← visible, permanent record
  → CLI resolves pending promise
  → tool-call-end emitted to stream
```

**Benefit**: the full permission lifecycle is part of the permanent transcript. The RPC side-channel can still exist for the actual real-time delivery mechanism, but the messages are also recorded in the stream for replay/audit.

---

## Full Type Definition (TypeScript)

```typescript
type MessageBase = {
  id: string;              // cuid2
  time: number;            // unix timestamp ms
  turn?: string;           // turn id
  parentId?: string;       // parent tool call id (for nesting)
  agentId?: string;        // subagent identity
};

// --- Agent messages ---

type AgentTurnStart = MessageBase & {
  role: "agent";
  type: "turn-start";
  turn: string;
};

type AgentTurnEnd = MessageBase & {
  role: "agent";
  type: "turn-end";
  turn: string;
  status: "completed" | "failed" | "cancelled";
};

type AgentTextMessage = MessageBase & {
  role: "agent";
  type: "text";
  turn: string;
  text: string;
  thinking?: boolean;
};

type AgentToolCallStart = MessageBase & {
  role: "agent";
  type: "tool-call-start";
  turn: string;
  callId: string;
  toolName: string;
  title: string;
  description: string;
  args: Record<string, unknown>;
  agentTitle?: string;     // human-readable label when this tool call spawns a subagent
};

type AgentToolCallEnd = MessageBase & {
  role: "agent";
  type: "tool-call-end";
  turn: string;
  callId: string;
  error?: string;
};

type AgentPermissionRequest = MessageBase & {
  role: "agent";
  type: "permission-request";
  turn: string;
  callId: string;
  toolName: string;
  title: string;
  description?: string;
  args?: Record<string, unknown>;
  options: Array<{
    id: string;
    label: string;
    kind: "allow-once" | "allow-always" | "reject-once" | "reject-always";
  }>;
};

type AgentPhotoMessage = MessageBase & {
  role: "agent";
  type: "photo";
  turn: string;
  ref: string;
  thumbhash: string;
  width: number;
  height: number;
};

type AgentVideoMessage = MessageBase & {
  role: "agent";
  type: "video";
  turn: string;
  ref: string;
  thumbhash: string;
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
  size: number;
};

type AgentFileMessage = MessageBase & {
  role: "agent";
  type: "file";
  turn: string;
  ref: string;
  name: string;
  size: number;
  mimeType: string;
};

type AgentServiceMessage = MessageBase & {
  role: "agent";
  type: "service";
  turn?: string;
  text: string;
};

// --- User messages ---

type UserTextMessage = MessageBase & {
  role: "user";
  type: "text";
  text: string;
};

type UserPermissionResponse = MessageBase & {
  role: "user";
  type: "permission-response";
  callId: string;
  optionId: string;
};

type UserPhotoMessage = MessageBase & {
  role: "user";
  type: "photo";
  ref: string;
  thumbhash: string;
  width: number;
  height: number;
};

type UserVideoMessage = MessageBase & {
  role: "user";
  type: "video";
  ref: string;
  thumbhash: string;
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
  size: number;
};

type UserFileMessage = MessageBase & {
  role: "user";
  type: "file";
  ref: string;
  name: string;
  size: number;
  mimeType: string;
};

// --- Unions ---

type AgentMessage =
  | AgentTurnStart
  | AgentTurnEnd
  | AgentTextMessage
  | AgentToolCallStart
  | AgentToolCallEnd
  | AgentPermissionRequest
  | AgentPhotoMessage
  | AgentVideoMessage
  | AgentFileMessage
  | AgentServiceMessage;

type UserMessage =
  | UserTextMessage
  | UserPermissionResponse
  | UserPhotoMessage
  | UserVideoMessage
  | UserFileMessage;

type SessionMessage = AgentMessage | UserMessage;
```

---

## What Stays the Same

- **Outer encrypted envelope**: `{ c: "<base64>", t: "encrypted" }` — server never sees content
- **WebSocket transport**: Socket.IO for real-time, REST for message fetch
- **Update types**: `new-message`, `update-session`, `update-machine` — unchanged
- **Message storage**: server stores opaque encrypted blobs, same as today
- **`messages.ts` types**: `SessionMessageContent`, `SessionMessage`, `Update*` schemas — unchanged
- **RPC mechanism**: still used for real-time permission delivery (and other RPCs), but permission messages are also written to the stream

## What Changes

| Before (v1) | After (v2) | Rationale |
|---|---|---|
| `ev.t` (single letter) | `type` (full word) | Human/AI readability |
| `ev.text` | `text` | Flat, no nesting |
| `ev.call` | `callId` | Descriptive |
| `ev.name` | `toolName` | Descriptive |
| Nested `ev` object | Flat top-level fields | One less level of nesting |
| `role: "session"` wrapper | `role: "agent"` / `role: "user"` directly | No unnecessary indirection |
| Single `tool-call` with mutable `status` | Separate `tool-call-start` / `tool-call-end` | Immutable append-only stream |
| `invoke` field (subagent) | `parentId` + `agentId` fields | `parentId` for nesting, `agentId` for subagent identity |
| No permissions in protocol | `permission-request` / `permission-response` | Audit trail, visible in transcript |
| No media types | `photo` + `video` (with thumbhash) + `file` | First-class media — aligns with encrypted-media-v1.md plan |
| Permissions via agent state + RPC only | Permissions in stream + RPC for delivery | Best of both — permanent record + real-time |

## Design Rules

1. **Immutable stream** — messages are never updated, only appended
2. **Upload-first** — files and photos are uploaded/encrypted to the server, then referenced by `ref`
3. **Every message has identity** — `id` (cuid2) + `time` (ms) on every message
4. **11 event types** — simple `switch(type)` in any client
5. **Provider-agnostic** — no agent backend leaks into the protocol
6. **Consistent naming** — all `kebab-case` for types, `camelCase` for fields
7. **Inline markdown** — `title` and `description` support `` `code` ``, **bold**, *italic*, [links]
8. **Parent chain** — `parentId` enables arbitrary nesting without separate lifecycle events per nesting level

## Migration Path

**Key fact: v1 was never published to any CLI release.** Production CLIs (0.13.0) use the legacy `role: 'agent'` / `role: 'user'` format. v1 only ran in dev environments. This means we have zero backward compatibility obligations for v1 — we can replace it entirely.

### Phase 1: Define v2 types, delete v1
- Replace `sessionProtocol.ts` with `sessionProtocolV2.ts` containing Zod schemas matching the types above
- No need to keep v1 types — they were never shipped
- Update `happy-wire/src/index.ts` to export v2

### Phase 2: Update CLI mappers
- Rewrite `claude/utils/sessionProtocolMapper.ts` to emit v2 format
- Rewrite `codex/utils/sessionProtocolMapper.ts` to emit v2 format
- Rewrite `agent/acp/AcpSessionManager.ts` to emit v2 format
- Add permission-request/response messages to the stream alongside existing RPC flow

### Phase 3: Update app normalization
- Update `typesRaw.ts` to accept v2 inner envelopes
- v2 normalization should be simpler — flatter structure, less transformation
- Keep legacy (`role: 'agent'` / `role: 'user'`) normalization for production CLIs still in the wild
- Can drop v1 normalization entirely (it was only used in dev)

### Phase 4: Permission migration
- App renders permission UI from stream messages instead of (or in addition to) agent state
- RPC still used for real-time delivery, but the message is the source of truth
- Eventually deprecate agent state `requests` / `completedRequests`

## Open Questions

- **Versioning**: should messages carry a `version` field, or do we detect format by shape? (Leaning toward shape detection — the `type` field values are unique enough)
- **Plan messages**: ACP has a `plan` update type (prioritized entries). Do we want this? Could be useful for the manager/conductor workflow.
- **Message consumption**: need read receipts at the protocol level? (See backlog — "message consumption visibility")
- **Streaming deltas vs complete messages**: Pi streams text deltas. We currently send complete text blocks. Should we support deltas for lower latency? (Probably not yet — keep it simple)
- **Permission auto-approval**: when a tool is auto-approved (e.g. `allow-always` from a previous decision), should we still emit `permission-request` + `permission-response` to the stream for the audit trail? Or skip them for noise reduction?

### Attachments as parts vs separate messages — NEEDS DESIGN

The current design models `photo`, `video`, and `file` as standalone messages in the stream. This works fine for agent output (agent produces media, emits a message). But it's awkward for **user input with attachments**:

- User sends "what's in this screenshot?" + an image — that's conceptually ONE message with TWO parts (text + photo)
- If sent as two separate messages (`photo` then `text`), there's no guarantee they arrive/render together
- The agent may see the text before the image, or vice versa
- Batching separate messages atomically is annoying at the transport level

**How others handle this:**

- **Claude API**: messages have `content: Array<TextBlock | ImageBlock | ...>` — multi-part by design
- **A2A**: messages have `parts: Array<Part>` where each part can be text, file, or structured data
- **ACP (Zed)**: prompts have `prompt: Array<TextContent | ResourceContent>` — multi-part
- **Pi**: user messages have `attachments: Array<Attachment>` alongside the text content
- **MCP**: tool results have `content: Array<TextContent | ImageContent | ...>` — multi-part

Every protocol uses a **parts/content array** for this. Our flat "one message = one thing" model doesn't handle "text + attachment sent together" well.

**Options to consider:**

1. **Add a `parts` array** — a user message can carry `parts: [{ type: "text", text: "..." }, { type: "photo", ref: "...", ... }]`. This is the Claude/A2A approach. Clean but means user messages become structurally different from the flat event stream.

2. **Add a `groupId` field** — messages that should be treated as one atomic input share a `groupId`. Transport batches them. Keeps the flat stream but adds coordination complexity.

3. **Keep standalone messages, add ordering guarantees** — the transport ensures messages from the same sender in quick succession are delivered in order. The app groups consecutive user messages visually. Simplest but weakest guarantee.

4. **Hybrid** — agent messages stay flat (one event per message), user messages get a `parts` array. Different shapes for different roles. Ugly but pragmatic.

**Also relevant:** we currently only have **server-hosted media** (`ref` pointing to encrypted upload). We'll want **machine-native files** soon (files on the remote machine, referenced by path). And eventually **app-uploaded files** (user attaches from phone/browser). These are three different `ref` schemes that the `file`/`photo`/`video` types need to support — the `ref` field will need to distinguish between `media/<id>` (our uploads), `machine-file://<path>` (remote machine), etc.

### Evidence from Claude Code session logs

Analysis of the current session's JSONL log (grouped by `message.id` to reconstruct actual API messages):

**Assistant messages are multi-block:**
```
 63x  tool_use                              (single tool call)
 46x  text                                  (just text)
 26x  text + tool_use                       (text then tool call)
 15x  tool_use + tool_use                   (2 parallel tool calls)
  5x  text + tool_use + tool_use            (text then 2 parallel calls)
  3x  tool_use × 3                          (3 parallel calls)
  1x  thinking + text + tool_use × 5        (thinking, text, 5 parallel calls)
```

**User/tool-result messages are heavily batched:**
```
  4x  tool_result × 7
  3x  tool_result × 4
  3x  tool_result × 8
  2x  tool_result × 10
  1x  tool_result × 18
  1x  tool_result + text + tool_result      (results interleaved with injected text)
```

Claude Code **streams each block as a separate JSONL entry**, but the actual API message groups them by `message.id`. When Claude requests 3 parallel tool calls, that's ONE message with 3 `tool_use` blocks. The results come back as ONE message with 3 `tool_result` blocks.

**Implication:** Our flat "one event per message" model **loses this batching information**. Three separate `tool-call-start` events don't convey that they were requested as a parallel batch. This matters for:
- Display (the UI could show parallel calls side-by-side)
- Semantics (the agent intended these as a group, not sequential)
- User input (text + attachment is one atomic user intent)

This is another argument for the `parts` approach, at least for some message types. But it also suggests a lighter alternative: a `batchId` field that groups events without changing the flat structure.

**Decision: deferred.** This needs more thought. For now, keep the flat model — it works for the streaming display use case. Revisit when user-side attachments ship or when parallel tool call display matters.

## References

- [ACP (Zed) spec](https://agentclientprotocol.com/overview/introduction)
- [ACP Registry](https://zed.dev/acp)
- [Pi coding agent RPC](https://github.com/badlogic/pi-mono)
- [MCP spec (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [A2A v1.0.0 (2026-03-12)](https://github.com/a2aproject/A2A)
- [AGNTCY Agent Connect Protocol](https://github.com/agntcy/acp-spec)
- [Linux Foundation AAIF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Original v1 session protocol spec](../session-protocol.md) — by Steve, Feb 2026
