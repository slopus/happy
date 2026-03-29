# Provider Envelope Redesign

Status: **DRAFT — v2 (OpenCode-derived)**

Previous version of this doc proposed `user-message` + `agent-event` as two flat
payload kinds. This revision replaces that with OpenCode's message+parts model,
adapted for Happy's encrypted storage and with permissions/questions unified into
tool state instead of side-channel events.

## Why this exists

The current inner message layer has become too hard to reason about.

Today the app must normalize multiple plaintext payload families after decryption:

- legacy user messages
- legacy agent `output` messages
- legacy `codex` messages
- legacy `acp` messages
- legacy `event` messages
- modern `role: "session"` envelopes

That fan-in is visible in
[`packages/happy-app/sources/sync/typesRaw.ts`](../../packages/happy-app/sources/sync/typesRaw.ts),
and it is the real source of the complexity.

The problem is not transport. Transport is fine (encrypted blobs, ordered
per-session messages, v3 HTTP read/write, Socket.IO invalidation). The messy
part is the **provider envelope shape inside the encrypted message body**.

## Research base

This design is grounded in cross-vendor protocol research:

- `docs/competition/opencode/runtime-tracing.md` — real traced exchanges
- `docs/competition/opencode/message-protocol.md` — protocol analysis
- `docs/competition/codex/message-protocol.md` — approval model reference
- `docs/competition/claude/message-protocol.md` — agent teams reference
- `docs/competition/comparison-matrix.md` — cross-vendor summary

OpenCode source at commit `2e0d5d230893dbddcefb35a02f53ff2e7a58e5d0`:

- `packages/opencode/src/session/message-v2.ts` — message + part schemas
- `packages/opencode/src/session/processor.ts` — tool state machine
- `packages/opencode/src/permission/index.ts` — permission ask/reply flow
- `packages/opencode/src/question/index.ts` — question ask/reply flow
- `packages/opencode/src/tool/todo.ts` — todo tool
- `packages/opencode/src/tool/question.ts` — question tool

## Key decisions up front

### 1. Adopt OpenCode's message+parts shape

Two record types: **Message** (the envelope) and **Part** (ordered content).
Messages are discriminated on `role` (user / assistant). Parts are discriminated
on `type` (text, tool, reasoning, etc).

We are copying this almost verbatim. It is proven in production, we have full
runtime traces, and there is no reason to invent a different shape.

### 2. Permissions and questions live on the tool part — not side-channel

OpenCode puts permissions on a separate SSE event (`permission.asked` /
`permission.replied`). The tool part stays `"running"` while blocked, and the
permission decision is not durably recorded on the tool.

We think this is wrong. In OpenCode:

- If you reload after a session completes, you cannot tell which tool calls
  required approval vs which auto-approved
- The app must listen to two separate event types and merge them with tool state
- Permission history is ephemeral

Instead, we add an explicit `"blocked"` status to the tool state machine. The
tool part itself carries the permission/question request and decision. No
separate event types needed — the tool part updates, which emits the same
`message.part.updated` that every other tool state transition uses.

### 3. No special SSE event types for permissions, questions, or todos

A tool state change is a tool state change. When a tool becomes blocked, the
SSE stream emits `message.part.updated` with the tool part showing `status:
"blocked"`. When the user responds, another `message.part.updated` fires with
the tool part showing `status: "running"` or `status: "error"`.

Push notifications (mobile, desktop) are a separate concern — triggered by
whatever state change is relevant, not coupled to protocol event taxonomy.

### 4. Subagents are child sessions

The `task` tool creates a real child session with its own `sessionID`,
`parentID`, and constrained permissions. The parent transcript records the
delegation as a tool part. The child session has its own full transcript.
Resumable by session ID.

### 5. Todos are a tool + side store

`todowrite` is a normal tool — creates a tool part. Separately, it writes to a
todo store (separate table or state). The todo store exists for quick reads
("what are current todos?") without walking the transcript. This is the one
case where a side store earns its keep.

### 6. Patchable canonical messages, not delta replay

Messages are patched in place as they evolve (tool pending → blocked →
running → completed). Sync sends the full updated message. Refetch returns
latest state. We do not adopt OpenCode's raw `message.part.delta` replay as
the durable sync model.

## The model

### Message Info (envelope)

Discriminated on `role`:

```ts
// ── User Message ──────────────────────────────────────────
type UserMessage = {
  id: string            // "msg_..." ascending
  sessionID: string     // "ses_..."
  role: "user"
  time: { created: number }
  agent: string         // "build" | "explore" | "plan" | ...
  model: {
    providerID: string  // "anthropic" | "openai" | ...
    modelID: string     // "claude-sonnet-4-6" | ...
  }
  format?: OutputFormat
  system?: string       // system prompt snapshot (debugging only)
  tools?: Record<string, boolean>
  variant?: string
  summary?: {
    title?: string
    body?: string
    diffs: FileDiff[]
  }
}

// ── Assistant Message ─────────────────────────────────────
type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID: string      // FK → UserMessage.id that triggered this
  modelID: string
  providerID: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  finish?: string       // "stop" | "tool-calls" | "length"
  error?: MessageError
  summary?: boolean     // true if compaction summary
  variant?: string
}

type Message = UserMessage | AssistantMessage
```

All usage stats, cost, model info, token counts live here. The app always has
this data without walking parts.

### Parts (ordered content within a message)

Every part shares a base:

```ts
type PartBase = {
  id: string         // "prt_..." ascending
  sessionID: string
  messageID: string  // FK → Message.id
}
```

Discriminated union on `type`:

```ts
type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | StepStartPart
  | StepFinishPart
  | SubtaskPart
  | AgentPart
  | SnapshotPart
  | PatchPart
  | CompactionPart
  | RetryPart
```

#### TextPart

```ts
type TextPart = PartBase & {
  type: "text"
  text: string
  synthetic?: boolean   // injected by system, not typed by user
  ignored?: boolean     // present but excluded from model context
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}
```

#### ReasoningPart

```ts
type ReasoningPart = PartBase & {
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
  metadata?: Record<string, unknown>
}
```

#### ToolPart — the big one

```ts
type ToolPart = PartBase & {
  type: "tool"
  callID: string
  tool: string          // "bash" | "writeFile" | "task" | "question" | ...
  state: ToolState
  metadata?: Record<string, unknown>
}
```

#### Tool state machine

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
  | ToolStatePending
  | ToolStateRunning
  | ToolStateBlocked
  | ToolStateCompleted
  | ToolStateError

type ToolStatePending = {
  status: "pending"
  input: Record<string, unknown>
  raw: string                    // raw input string as it streams in
}

type ToolStateRunning = {
  status: "running"
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
}

type ToolStateBlocked = {
  status: "blocked"
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
  block: PermissionBlock | QuestionBlock
}

type ToolStateCompleted = {
  status: "completed"
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number; compacted?: number }
  attachments?: FilePart[]
  block?: ResolvedBlock          // preserved if tool was blocked before completing
}

type ToolStateError = {
  status: "error"
  input: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
  block?: ResolvedBlock          // preserved if tool was blocked before erroring
}
```

#### Block types

```ts
type PermissionBlock = {
  type: "permission"
  id: string                     // stable request ID
  permission: string             // "edit" | "bash" | "task" | ...
  patterns: string[]             // ["src/api/server.ts"] — what's being accessed
  always: string[]               // patterns to auto-approve if user says "always"
  metadata: Record<string, unknown>  // diff payload, filepath, etc
}

type QuestionBlock = {
  type: "question"
  id: string
  questions: QuestionInfo[]
}

type QuestionInfo = {
  question: string
  header: string                 // short label (max 30 chars)
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean               // allow free-text answer (default true)
}

// After the user responds, the block becomes resolved and is preserved
// on the completed/error state for audit trail
type ResolvedBlock =
  | ResolvedPermissionBlock
  | ResolvedQuestionBlock

type ResolvedPermissionBlock = {
  type: "permission"
  id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  decision: "once" | "always" | "reject"
  decidedAt: number
}

type ResolvedQuestionBlock = {
  type: "question"
  id: string
  questions: QuestionInfo[]
  answers: string[][]            // per-question array of selected labels
  decidedAt: number
}
```

#### Why `blocked` instead of OpenCode's approach

OpenCode keeps the tool at `"running"` while permission is pending and fires a
separate `permission.asked` SSE event. The problems:

1. **No durable record** — permission decisions are ephemeral events, not
   persisted on the tool part. Reload the page after the session ends and you
   lose all permission history.
2. **Separate event types** — the app must handle `permission.asked`,
   `permission.replied`, `question.asked`, `question.replied` as special
   protocol events and merge them with tool state. More reducer branches.
3. **Ambiguous tool state** — a tool at `"running"` could mean "executing" or
   "blocked waiting for the user". The app cannot distinguish without checking
   the side-channel.

With `"blocked"`:

1. **Durable** — the permission request and decision live on the tool part
   forever. Auditable.
2. **Same update path** — tool goes blocked → `message.part.updated`. Tool
   unblocks → `message.part.updated`. No new event types. The app reducer
   just handles tool state transitions.
3. **Unambiguous** — `"running"` means executing, `"blocked"` means waiting
   for user. The UI knows exactly what to render without checking anything else.

#### Remaining part types

```ts
type FilePart = PartBase & {
  type: "file"
  mime: string
  filename?: string
  url: string                    // "data:..." inline or ref to encrypted blob
  source?: FilePartSource
}

type StepStartPart = PartBase & {
  type: "step-start"
  snapshot?: string              // git commit hash
}

type StepFinishPart = PartBase & {
  type: "step-finish"
  reason: string                 // "stop" | "tool-calls" | "length"
  snapshot?: string
  cost: number
  tokens: {
    input: number; output: number; reasoning: number
    cache: { read: number; write: number }
  }
}

type SubtaskPart = PartBase & {
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

type AgentPart = PartBase & {
  type: "agent"
  name: string
}

type SnapshotPart = PartBase & { type: "snapshot"; snapshot: string }
type PatchPart    = PartBase & { type: "patch"; hash: string; files: string[] }

type CompactionPart = PartBase & {
  type: "compaction"
  auto: boolean
  overflow?: boolean
}

type RetryPart = PartBase & {
  type: "retry"
  attempt: number
  error: APIError
  time: { created: number }
}
```

## Session record

```ts
type Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string              // set for child sessions (subagents)
  title: string
  time: {
    created: number
    updated: number
    compacting?: number
  }
  permission?: PermissionRule[]  // session-level rules
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: FileDiff[]
  }
}
```

## SSE event types

Minimal set. No special types for permissions, questions, or todos.

| Event | When |
|---|---|
| `session.created` | New session (including child sessions) |
| `session.updated` | Title, summary, metadata changed |
| `session.status` | idle / busy / retry |
| `session.error` | Unrecoverable session error |
| `session.compacted` | Context compaction completed |
| `message.updated` | Message info created or final state changed (tokens, cost, finish) |
| `message.removed` | Message deleted |
| `message.part.updated` | Part created or state changed (**including tool blocked/unblocked**) |
| `message.part.delta` | Streaming text append (partID + field + delta string) |
| `message.part.removed` | Part removed |
| `todo.updated` | Todo list replaced (convenience for todo dock, not a tool concern) |
| `file.edited` | File on disk changed by agent |
| `file.watcher.updated` | External file change detected |

Things conspicuously absent from this list:

- ~~`permission.asked`~~ — tool part goes `blocked`, `message.part.updated` fires
- ~~`permission.replied`~~ — tool part goes `running`/`error`, `message.part.updated` fires
- ~~`question.asked`~~ — tool part goes `blocked`, `message.part.updated` fires
- ~~`question.replied`~~ — tool part goes `running`/`error`, `message.part.updated` fires

Push notifications (mobile badge, desktop toast) are triggered by whatever
state change is relevant. That's a notification-layer concern, not a protocol
event taxonomy concern.

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

### Message 2 — Assistant (tool call, gets blocked, then completes)

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

Note: when this message is **final / persisted**, the tool part shows
`status: "completed"` with the resolved `block` showing what happened. But
during the live exchange, the SSE stream saw the tool part transition through:

```
1.  message.part.updated → tool, status: "pending"
2.  message.part.updated → tool, status: "running"
3.  message.part.updated → tool, status: "blocked", block: { type: "permission", ... }
    ← app renders permission prompt with diff preview
4.  message.part.updated → tool, status: "running"
    ← user approved, tool resumes
5.  message.part.updated → tool, status: "completed", block: { ..., decision: "once" }
```

No special event types. Just tool state transitions.

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

## Question tool exchange example

Agent calls the `question` tool to ask the user something:

```
1.  message.part.updated → tool "question", status: "pending"
2.  message.part.updated → tool "question", status: "running"
3.  message.part.updated → tool "question", status: "blocked",
      block: { type: "question", id: "q_001",
               questions: [{ question: "Which database?", header: "DB choice",
                             options: [{ label: "PostgreSQL", description: "..." },
                                       { label: "SQLite", description: "..." }] }] }
    ← app renders question UI
4.  message.part.updated → tool "question", status: "completed",
      block: { type: "question", ..., answers: [["PostgreSQL"]], decidedAt: ... },
      output: "User answered: Which database? = PostgreSQL"
```

Same update path. Same reducer logic.

## Subagents

### Creation

Parent agent calls `task` tool → CLI creates child session:

```jsonc
{
  "id": "ses_child_001",
  "parentID": "ses_01xyz",
  "title": "Find all API endpoints (@explore)",
  "directory": "/home/user/app",
  "permission": [
    { "permission": "edit", "pattern": "*", "action": "deny" },
    { "permission": "bash", "pattern": "*", "action": "deny" },
    { "permission": "task", "pattern": "*", "action": "deny" }
  ]
}
```

### Parent transcript records it

The `task` tool part on the parent assistant message:

```jsonc
{
  "type": "tool",
  "callID": "call_task_001",
  "tool": "task",
  "state": {
    "status": "completed",
    "input": { "description": "Find API endpoints", "prompt": "...",
               "subagent_type": "explore" },
    "output": "task_id: ses_child_001\n\n<task_result>\n...\n</task_result>",
    "title": "task → explore",
    "metadata": {
      "sessionId": "ses_child_001",
      "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
    },
    "time": { "start": 1753120005000, "end": 1753120012000 }
  }
}
```

### Child session

Has its own messages, parts, full transcript. Fetched via
`GET /session/:parentID/children` or `GET /session/:childID/message`.

### Permission constraining

Agent types define default permission overrides. Child cannot escalate beyond
parent. The merge is restrictive.

### UI

- Parent shows `task` tool part (collapsed, expandable)
- Clicking navigates to child session transcript
- `parentID` on session gives nesting

## Todos

`todowrite` is a normal tool → tool part in the transcript.

Inside execution, it writes to a separate todo store AND the tool output
contains the current list as JSON.

The `todo.updated` SSE event is the one side-channel we keep — it exists so
the UI can update a todo dock without scanning tool parts. The todo table is
the quick-read store for "what are current todos?"

```ts
type Todo = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}
```

## Permission rules

Rules come from three sources, merged in order:

1. **Project config** — `.happy/config.json` or equivalent
2. **Session creation** — passed when session is created
3. **Runtime approvals** — accumulated "always" decisions during the session

```ts
type PermissionRule = {
  permission: string   // "edit" | "bash" | "read" | "task" | ...
  pattern: string      // glob: "*", "*.ts", "src/**"
  action: "allow" | "deny" | "ask"
}
```

Evaluation: check rules in order. `deny` → tool errors immediately.
`allow` → tool runs, no block. `ask` → tool goes `blocked`.

If the user says `"always"`, the patterns from `block.always` are added to
runtime rules. Any other currently-blocked tools matching those patterns
auto-unblock.

If the user says `"reject"`, the tool errors AND all other pending blocked
tools in the same session also error (cascade reject — same as OpenCode).

## Storage model

### Happy's constraint: encrypted storage

OpenCode stores plaintext rows in SQLite and patches them freely. Happy stores
opaque encrypted blobs.

We choose **patchable canonical messages**:

- Message IDs are stable
- When a tool part transitions (pending → blocked → completed), re-encrypt
  the full message and store the update
- Sync sends the full updated encrypted message
- Refetch returns latest state without replay
- No append-only event log as primary storage

This matches Happy's existing message delivery model. The inner plaintext
shape changes; the storage/sync envelope does not.

### What does NOT change

- DB rows
- `seq` ordering
- `localId`
- v3 HTTP message APIs
- Socket.IO invalidation
- Encrypted blob format

## What moves out of agentState

Keep in agentState:
- Current mode
- Available models / modes
- Live session config
- Transient backend capabilities

Move to tool parts:
- Pending permission requests → tool `status: "blocked"`
- Completed permission decisions → tool `block` field
- Question prompts → tool `status: "blocked"`
- Question answers → tool `block` field

## Provider adapters

Every provider adapter normalizes into this exact format at the CLI boundary:

- Claude adapter → messages + parts
- Codex adapter → messages + parts
- OpenClaw adapter → messages + parts
- ACP runner → messages + parts
- Gemini adapter → messages + parts

The app sees one shape. Provider weirdness stays in CLI.

## App impact

The normalizer converges to: parse `UserMessage` + `AssistantMessage`, hydrate
parts, done.

Delete:
- Provider-specific `codex` parsing
- Provider-specific `acp` parsing
- `output` compatibility logic
- `role: "session"` handling

The reducer gets simpler:
- Tool lifecycle is one state machine on one part type
- Permissions are just tool state transitions — no separate merge
- Questions are just tool state transitions
- Grouping from `parentID` on sessions + tool metadata

## Migration plan

### Phase 1: add new schemas alongside existing

- Define `UserMessage`, `AssistantMessage`, `Part` types in CLI and app
- Keep legacy parsing
- Add compatibility path in reducer
- Support patching existing canonical messages

### Phase 2: migrate one provider end to end

Target: ACP runner or Codex (both have adapter boundaries and event streams).

### Phase 3: migrate permissions into tool state

- Tool goes `blocked` instead of emitting to agentState
- Keep agentState fallback temporarily
- Switch UI to render from tool part state

### Phase 4: migrate remaining providers

Claude, OpenClaw, Gemini.

### Phase 5: delete legacy parsing

Remove codex, acp, output, `role: "session"` parsing.

## Open questions

1. Should `block.metadata` for permissions always include the full diff, or
   should large diffs be a separate encrypted blob reference?
2. Do we need a `tool-progress` part type for long-running tools (e.g. bash
   streaming output), or is periodic patching of the running state enough?
3. Should provider-native IDs (e.g. OpenAI `call_...`) be stored on tool
   parts for debugging, or fully discarded after mapping?
4. Exact Zod schemas and field naming TBD during implementation — this doc
   specifies the shape and semantics, not final field names.

## What we are NOT doing

- ~~Special SSE event types for permissions~~ — tool state transitions
- ~~Special SSE event types for questions~~ — tool state transitions
- ~~Side-channel permission store~~ — it's on the tool part
- ~~Side-channel question store~~ — it's on the tool part
- ~~`role: "session"` wrapper~~ — dead
- ~~Nested `ev.t`~~ — dead
- ~~Raw delta replay as primary sync model~~ — patchable canonical messages
- ~~New "session protocol" umbrella~~ — it's just messages and parts
