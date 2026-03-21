# Provider Envelope Redesign

Status: **PLAN OF RECORD**
Branch: `messaging-protocol-v3`

---

## Acceptance criteria

Done when:

1. **Shared types in `happy-wire`** — `Message` (UserMessage | AssistantMessage),
   `Part` (discriminated union), `ToolState` (with `blocked`), `Block` types.
   Both CLI and app import from here.

2. **Claude adapter emits canonical messages+parts** — provider-native output
   normalized at CLI boundary. Text, reasoning, tool calls with full state
   machine including `blocked`, step lifecycle. First adapter.

3. **Codex adapter emits canonical messages+parts** — same shape. Codex
   approval model mapped to `blocked` tool state. Second adapter.

4. **OpenCode adapter emits canonical messages+parts** — same shape. OpenCode
   permission side-channel mapped to `blocked` tool state. Third adapter.

5. **Expo app store uses messages+parts** — legacy payloads converted to the
   new format on ingestion, before going into the store. The store only holds
   the new shape. Decrypt → convert (if legacy) → parse → store → render.
   One code path for rendering. No normalizer fan-in from 6 payload families
   at render time.

6. **Permission decisions on tool parts** — `block` field with `decision` and
   `decidedAt` survives encrypt → server → decrypt → refetch. Auditable.

7. **Question answers on tool parts** — same. `block.answers` survives the
   round trip.

8. **Legacy sessions still render** — old encrypted messages from before the
   migration are converted to the new format when ingested into the store.
   Legacy parsing is an ingestion-time concern, not a render-time concern.

9. **Integration test passes the exercise flow** — one long sequential test
   against lab-rat-todo-project covering: text response, permission
   reject/once/always/auto-approve, tool blocked→completed, question
   blocked→answered, cancel+cleanup, session resume with transcript intact.

10. **No new update mechanism for permissions/questions** — tool state changes
    (including blocked/unblocked) flow through the same message update path
    we use today. No new event types, no new side-channels.

---

## Scope

### In scope

Providers: **Claude, Codex, OpenCode** — in that order.

Packages touched:
- `happy-wire` — new shared types
- `happy-cli` — adapter normalization per provider
- `happy-app` — store migration, legacy conversion on ingestion, renderer

### Out of scope (for now)

- ACP adapter
- Gemini adapter
- OpenClaw adapter (will follow the pattern once the first three prove it)
- Replacing v3 HTTP message transport
- Replacing Socket.IO invalidation
- Redesigning encrypted media transport
- Standardizing tool RPC or MCP

---

## Why this exists

The app normalizes 6 plaintext payload families after decryption:

- legacy user messages
- legacy agent `output` messages
- legacy `codex` messages
- legacy `acp` messages
- legacy `event` messages
- modern `role: "session"` envelopes

Visible in `packages/happy-app/sources/sync/typesRaw.ts`. This is the real
source of reducer complexity.

Transport is fine. The messy part is the **provider envelope shape inside the
encrypted message body**.

## Research base

- `docs/competition/opencode/runtime-tracing.md` — real traced exchanges
- `docs/competition/opencode/message-protocol.md` — protocol analysis
- `docs/competition/codex/message-protocol.md` — approval model reference
- `docs/competition/claude/message-protocol.md` — agent teams reference
- `docs/competition/comparison-matrix.md` — cross-vendor summary
- `docs/competition/opencode/trace-opencode.sh` — rerunnable tracing harness

## Key decisions

### 1. Adopt OpenCode's message+parts shape

Two record types: **Message** (envelope) and **Part** (ordered content).
Messages discriminated on `role`. Parts discriminated on `type`.

### 2. Permissions and questions live on the tool part

Explicit `"blocked"` status in the tool state machine. The tool part carries
the permission/question request and the decision. No side-channel.

Why not OpenCode's approach (separate `permission.asked` events):

- No durable record — reload after session ends, permission history gone
- App must merge two event streams — more reducer branches
- Ambiguous — `"running"` could mean executing or waiting for user

With `"blocked"`:

- Durable — decision on the tool part forever
- Same update path — tool state change, same as every other transition
- Unambiguous — `"running"` = executing, `"blocked"` = waiting

### 3. No new update mechanisms

Tool state changes (including blocked/unblocked) use the same message update
path we already have. Not a new event type — just a message that changed.

### 4. Subagents are child sessions

`task` tool creates a child session with `parentID` and constrained
permissions. Parent records delegation as a tool part.

### 5. Todos are a tool + side store

`todowrite` is a normal tool (tool part in transcript). Also writes to a
separate todo store for quick reads.

### 6. Patchable canonical messages

Messages patched in place as tool parts evolve. Sync sends full updated
message. Refetch returns latest state. No delta replay.

### 7. Legacy conversion at ingestion, not render

Old messages are converted to the new format when they enter the app store.
The store only holds messages+parts. Rendering has one code path.

---

## The model

### Message Info (envelope)

```ts
type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string }
  format?: OutputFormat
  system?: string
  tools?: Record<string, boolean>
  variant?: string
  summary?: { title?: string; body?: string; diffs: FileDiff[] }
}

type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  parentID: string
  modelID: string
  providerID: string
  agent: string
  path: { cwd: string; root: string }
  cost: number
  tokens: {
    input: number; output: number; reasoning: number
    cache: { read: number; write: number }
  }
  finish?: string
  error?: MessageError
  summary?: boolean
  variant?: string
}

type Message = UserMessage | AssistantMessage
```

### Parts

```ts
type PartBase = {
  id: string
  sessionID: string
  messageID: string
}

type Part =
  | TextPart | ReasoningPart | ToolPart | FilePart
  | StepStartPart | StepFinishPart | SubtaskPart | AgentPart
  | SnapshotPart | PatchPart | CompactionPart | RetryPart
```

### Tool state machine

```
pending ──→ running ──→ completed
               │
               ├──→ blocked ──→ running ──→ completed
               │        │
               │        └──→ error (rejected)
               │
               └──→ error
```

```ts
type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string;
      metadata?: Record<string, unknown>; time: { start: number } }
  | { status: "blocked"; input: Record<string, unknown>; title?: string;
      metadata?: Record<string, unknown>; time: { start: number };
      block: PermissionBlock | QuestionBlock }
  | { status: "completed"; input: Record<string, unknown>; output: string;
      title: string; metadata: Record<string, unknown>;
      time: { start: number; end: number; compacted?: number };
      attachments?: FilePart[]; block?: ResolvedBlock }
  | { status: "error"; input: Record<string, unknown>; error: string;
      metadata?: Record<string, unknown>;
      time: { start: number; end: number }; block?: ResolvedBlock }
```

### Block types

```ts
type PermissionBlock = {
  type: "permission"
  id: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

type QuestionBlock = {
  type: "question"
  id: string
  questions: QuestionInfo[]
}

type ResolvedPermissionBlock = PermissionBlock & {
  decision: "once" | "always" | "reject"
  decidedAt: number
}

type ResolvedQuestionBlock = QuestionBlock & {
  answers: string[][]
  decidedAt: number
}

type ResolvedBlock = ResolvedPermissionBlock | ResolvedQuestionBlock
```

### Remaining part types

```ts
type TextPart = PartBase & {
  type: "text"; text: string; synthetic?: boolean;
  ignored?: boolean; time?: { start: number; end?: number };
  metadata?: Record<string, unknown>
}

type ReasoningPart = PartBase & {
  type: "reasoning"; text: string;
  time: { start: number; end?: number };
  metadata?: Record<string, unknown>
}

type ToolPart = PartBase & {
  type: "tool"; callID: string; tool: string;
  state: ToolState; metadata?: Record<string, unknown>
}

type FilePart = PartBase & {
  type: "file"; mime: string; filename?: string;
  url: string; source?: FilePartSource
}

type StepStartPart = PartBase & {
  type: "step-start"; snapshot?: string
}

type StepFinishPart = PartBase & {
  type: "step-finish"; reason: string; snapshot?: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number;
            cache: { read: number; write: number } }
}

type SubtaskPart = PartBase & {
  type: "subtask"; prompt: string; description: string;
  agent: string; model?: { providerID: string; modelID: string };
  command?: string
}

type AgentPart = PartBase & { type: "agent"; name: string }
type SnapshotPart = PartBase & { type: "snapshot"; snapshot: string }
type PatchPart = PartBase & { type: "patch"; hash: string; files: string[] }
type CompactionPart = PartBase & { type: "compaction"; auto: boolean; overflow?: boolean }
type RetryPart = PartBase & { type: "retry"; attempt: number; error: APIError; time: { created: number } }
```

---

## Full exchange example

User: *"Create hello.txt with 'hello world'."*
Session has edit permission rule forcing asks.

### Message 1 — User

```jsonc
{
  "info": {
    "id": "msg_01abc", "sessionID": "ses_01xyz", "role": "user",
    "time": { "created": 1753120000000 },
    "agent": "build",
    "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" }
  },
  "parts": [
    { "id": "prt_001", "sessionID": "ses_01xyz", "messageID": "msg_01abc",
      "type": "text",
      "text": "Create hello.txt with 'hello world'." }
  ]
}
```

### Message 2 — Assistant (tool call, blocked, then completed)

```jsonc
{
  "info": {
    "id": "msg_02def", "sessionID": "ses_01xyz", "role": "assistant",
    "time": { "created": 1753120001000, "completed": 1753120004000 },
    "parentID": "msg_01abc",
    "modelID": "claude-sonnet-4-6", "providerID": "anthropic",
    "agent": "build",
    "path": { "cwd": "/home/user/app", "root": "/home/user/app" },
    "cost": 0.0087,
    "tokens": { "input": 4200, "output": 340, "reasoning": 0,
                "cache": { "read": 3800, "write": 400 } },
    "finish": "tool-calls"
  },
  "parts": [
    { "id": "prt_010", "type": "step-start", "snapshot": "a1b2c3d4",
      "sessionID": "ses_01xyz", "messageID": "msg_02def" },

    { "id": "prt_011", "type": "reasoning",
      "text": "I'll create the file using writeFile...",
      "time": { "start": 1753120001100, "end": 1753120001400 },
      "sessionID": "ses_01xyz", "messageID": "msg_02def" },

    { "id": "prt_012", "type": "tool",
      "callID": "call_abc123", "tool": "writeFile",
      "sessionID": "ses_01xyz", "messageID": "msg_02def",
      "state": {
        "status": "completed",
        "input": { "path": "hello.txt", "content": "hello world\n" },
        "output": "Created hello.txt (12 bytes)",
        "title": "writeFile hello.txt",
        "metadata": {},
        "time": { "start": 1753120001500, "end": 1753120003800 },
        "block": {
          "type": "permission",
          "id": "per_001",
          "permission": "edit",
          "patterns": ["hello.txt"],
          "always": ["*"],
          "metadata": {
            "filepath": "hello.txt",
            "files": [{ "relativePath": "hello.txt", "type": "add",
                        "after": "hello world\n", "additions": 1, "deletions": 0 }]
          },
          "decision": "once",
          "decidedAt": 1753120002500
        }
      }
    },

    { "id": "prt_013", "type": "step-finish", "reason": "tool-calls",
      "snapshot": "e5f6g7h8", "cost": 0.0087,
      "tokens": { "input": 4200, "output": 340, "reasoning": 0,
                  "cache": { "read": 3800, "write": 400 } },
      "sessionID": "ses_01xyz", "messageID": "msg_02def" }
  ]
}
```

Live, the tool part transitioned through:

```
1. tool, status: "pending"
2. tool, status: "running"
3. tool, status: "blocked", block: { type: "permission", ... }
4. tool, status: "running"        ← user approved
5. tool, status: "completed", block: { ..., decision: "once" }
```

Each transition is a message update through the existing path.

### Message 3 — Assistant (final text)

```jsonc
{
  "info": {
    "id": "msg_03ghi", "sessionID": "ses_01xyz", "role": "assistant",
    "time": { "created": 1753120004100, "completed": 1753120004800 },
    "parentID": "msg_01abc",
    "modelID": "claude-sonnet-4-6", "providerID": "anthropic",
    "agent": "build",
    "path": { "cwd": "/home/user/app", "root": "/home/user/app" },
    "cost": 0.0023,
    "tokens": { "input": 4600, "output": 45, "reasoning": 0,
                "cache": { "read": 4200, "write": 400 } },
    "finish": "stop"
  },
  "parts": [
    { "id": "prt_020", "type": "step-start",
      "sessionID": "ses_01xyz", "messageID": "msg_03ghi" },
    { "id": "prt_021", "type": "text",
      "text": "Done. Created `hello.txt` with \"hello world\".",
      "sessionID": "ses_01xyz", "messageID": "msg_03ghi" },
    { "id": "prt_022", "type": "step-finish", "reason": "stop",
      "cost": 0.0023,
      "tokens": { "input": 4600, "output": 45, "reasoning": 0,
                  "cache": { "read": 4200, "write": 400 } },
      "sessionID": "ses_01xyz", "messageID": "msg_03ghi" }
  ]
}
```

---

## Subagents

Parent calls `task` tool → CLI creates child session with `parentID` and
constrained permissions. Parent tool part has `metadata.sessionId` linking
to the child. Child has its own messages and parts. Resumable by session ID.

```jsonc
// child session
{
  "id": "ses_child_001",
  "parentID": "ses_01xyz",
  "title": "Find API endpoints (@explore)",
  "permission": [
    { "permission": "edit", "pattern": "*", "action": "deny" },
    { "permission": "bash", "pattern": "*", "action": "deny" },
    { "permission": "task", "pattern": "*", "action": "deny" }
  ]
}
```

## Todos

`todowrite` is a normal tool → tool part in transcript. Also writes to
separate todo store for quick reads. One side-channel that earns its keep.

## Permission rules

Three sources merged in order: project config, session creation, runtime
approvals. `deny` → immediate error. `allow` → no block. `ask` → blocked.
`always` reply adds to runtime rules and auto-unblocks matching pending tools.
`reject` cascades to all pending blocked tools in the session.

---

## Architecture: shared model

```
CLI adapters ──→ Message + Parts (canonical) ──→ encrypt ──→ server
                                                                │
                                          ┌─────────────────────┘
                                          ▼
                              app decrypts ──→ if legacy: convert to
                                                Message + Parts
                                              ──→ store (new format only)
                                              ──→ render (one code path)
```

The shared package is `happy-wire`. Both CLI and app import `Message`, `Part`,
`ToolState`, `Block` types from there. CLI produces them, app consumes them.
Encrypted transport in between is dumb pipe.

The app store holds only the new format. Legacy messages are converted on
ingestion (decrypt → detect format → convert if needed → store). Rendering
never sees legacy shapes.

---

## Implementation plan

Work happens on branch `messaging-protocol-v3`. Incremental commits at
meaningful checkpoints.

### Phase 1: shared types

Define Zod schemas in `happy-wire`:
- `Message` (UserMessage | AssistantMessage)
- `Part` (discriminated union)
- `ToolState` (with `blocked`)
- `Block` types (PermissionBlock, QuestionBlock, resolved variants)

No runtime changes. Just the type definitions that both sides will import.

### Phase 2: Claude adapter

Normalize Claude provider output into messages+parts at the CLI boundary.
This is the first adapter because:
- Claude is our primary provider
- `claude.integration.test.ts` already covers clarification, model switch,
  MCP tools, write boundaries, permission deny, interrupt, TodoWrite
- Most surface area to validate the format against

Checkpoint: Claude sessions produce canonical messages+parts that pass
schema validation.

### Phase 3: Codex adapter

Map Codex's thread/turn/item model and approval requests into the same
messages+parts shape. Codex approvals map to `blocked` tool state.

Codex is second because:
- `codex.integration.test.ts` already covers permission approve/deny/cancel,
  context preservation, reconnect+resume, interrupt during permission
- Codex has the most different approval model — proving it normalizes
  validates the blocked/unblocked design

Checkpoint: Codex sessions produce same canonical shape as Claude.

### Phase 4: OpenCode adapter

Map OpenCode's message+parts (which we're largely copying) through our
adapter. OpenCode's `permission.asked` side-channel maps to `blocked`.

OpenCode is third because:
- Closest to our target format already
- Validates that the shape works when the source is nearly identical

Checkpoint: all three providers produce identical message+parts shape.

### Phase 5: app store migration

- Add legacy → messages+parts converter at ingestion boundary
- Migrate app store to hold only the new format
- Single rendering code path for messages+parts
- Legacy parsing becomes ingestion-only, not render-time

Checkpoint: app renders old and new sessions through one code path.

### Phase 6: integration test

One long sequential test against lab-rat-todo-project following the
exercise flow in `environments/lab-rat-todo-project/exercise-flow.md`.

Must cover:
- Text response, reasoning
- Permission reject → error
- Permission once → completed
- Permission always → auto-approve
- Tool blocked → completed with block.decision preserved
- Question blocked → answered with block.answers preserved
- Cancel + cleanup
- Session resume with full transcript intact
- Legacy session still renders after store migration

### Phase 7: delete legacy rendering

After all three providers emit messages+parts and old sessions convert
cleanly, remove legacy parsing from the rendering path. It stays only
in the ingestion converter.

---

## Open questions

1. Should `block.metadata` for permissions always include the full diff, or
   should large diffs be a separate encrypted blob reference?
2. Do we need `tool-progress` for long-running tools (e.g. bash streaming),
   or is periodic patching of running state enough?
3. Should provider-native IDs (OpenAI `call_...`) be stored for debugging
   or discarded after mapping?

## What we are NOT doing

- ~~ACP / Gemini / OpenClaw adapters~~ — later, same pattern
- ~~New SSE event types for permissions~~ — same message update path
- ~~Side-channel permission store~~ — on the tool part
- ~~`role: "session"` wrapper~~ — dead
- ~~Nested `ev.t`~~ — dead
- ~~Raw delta replay as sync model~~ — patchable canonical messages
- ~~New "session protocol" umbrella~~ — it's just messages and parts
