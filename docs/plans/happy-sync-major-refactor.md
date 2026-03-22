# happy-sync: Major Refactor

Status: **SPECIFICATION — ACTIVE WORK** (branch: `happy-sync-refactor`)
Supersedes: `provider-envelope-redesign.md`, `provider-envelope-testing.md`,
the failed `messaging-protocol-v3` branch

> **Note:** The v3 migration on branch `messaging-protocol-v3` **failed**.
> After 15 iterations (~8 hours) of a Codex agent loop, the integration tests
> never once ran to completion (0/155 launches produced a result). The unit
> tests pass — protocol schemas, Claude mapper, Codex mapper — but the
> integration test approach was architecturally doomed (see "Lessons from the
> failed v3 attempt" below). This refactor IS the v3 migration. We are doing
> it all at once: building `SyncNode`, wiring it through everything, killing
> the old transport/converter/agent code, and making the integration tests
> actually work. The protocol types and mappers from the failed branch are
> proven and will be carried forward.

---

## Definition of Done

This work is **only done** when the design matches **exactly all requirements
below** — especially the testing on **all four levels**, and the exercise flow
on levels 2 and 3 **covers all 34 user interactions** as defined in
`environments/lab-rat-todo-project/exercise-flow.md`.

Partial coverage is not done. A subset of steps is not done. Tests that skip
steps are not done. If the exercise flow adds steps, the tests must grow to
match. The flow is the source of truth; the tests are its proof.

### Acceptance Criteria

Every criterion must be met. No exceptions, no "good enough", no "we'll
add that later."

1. **`happy-sync` package exists** — renamed from `happy-wire`. Contains the
   v3 protocol types (Zod schemas), `SyncNode` class, and encryption. This
   is the single shared package imported by CLI, daemon, app, and tests.

2. **`SyncNode` is the only sync primitive** — all consumers (CLI session
   processes, daemon, React Native app, integration tests) instantiate
   `SyncNode` to send, receive, and read state. No other sync path exists.
   No direct HTTP calls to the server for message transport. No separate
   `SessionClient`, `ApiSessionClient`, or `SyncSocket` classes.

3. **One type system everywhere clients have keys** — `MessageWithParts`
   (from `happy-sync`) is the canonical type used in the CLI mappers, the
   app store, and the React components. The **server never sees these types**
   — it stores opaque encrypted blobs, assigns seq numbers, and broadcasts
   notifications. It is a dumb encrypted pipe. No converter. No intermediate
   `Message` kind system. No `AgentTextMessage`, `ToolCallMessage`, or
   other flattened representations. The UI renders `Part` directly: text
   part → text component, tool part → tool component, reasoning part →
   thinking component.

4. **Sessions are conversations, child sessions are subagents** — a
   **session** is both the sync/auth scope AND the conversation. One
   `SyncNode` connection, one set of encryption keys, one token. Each
   session has its own messages, permissions, questions, todos, and status.
   Subagents create **child sessions** (linked via `parentID` on
   `SessionInfo`, which already exists in the protocol). This matches
   OpenCode's model where subagents are child sessions. The CLI patches
   messages in-place as tool states evolve (blocked → running → completed),
   sending updated `MessageWithParts` through the same message update path.

5. **Token carries claims** — the `SyncNode` token is a JWT with claims
   that specify scope (`account` or `session`) and permissions. Session-
   scoped tokens are restricted to one session. Account-scoped tokens have
   full lifecycle access (create/list/stop sessions). The server validates
   these claims. `SyncNode` can introspect its own token.

6. **One transport** — Socket.IO. No abstraction layer, no factory, no
   pluggable transports. If we ever switch, we switch everywhere at once.

7. **Each session process owns its own `SyncNode`** — the daemon does not
   accumulate message state. It has an account-scoped `SyncNode` for
   lifecycle operations (create/list/stop sessions, listen for new session
   events). Each CLI session process (Claude, Codex, OpenCode) has its own
   session-scoped `SyncNode`. The app has its own account-scoped `SyncNode`.

8. **`happy-agent` package is absorbed** — the daemon takes over its
   lifecycle role. Integration tests use `SyncNode` directly as the
   programmatic test harness. No CLI binary needed to drive tests.

9. **No backwards compatibility concern** — full migration to the new
   protocol. No legacy rendering path. No dual-write. No feature flags.
   No conversion at ingestion. If it's not v3 `MessageWithParts`, it
   doesn't exist.

10. **All four testing levels pass** — see Testing section below.

11. **All boundaries strictly typed with Zod** — every boundary where data
    crosses a trust boundary (network, IPC, storage, user input) is validated
    with Zod schemas at runtime. No `as unknown as T`. No `Record<string,
    unknown>` at public API surfaces. No `any`. The protocol types ARE the
    validation — `MessageWithPartsSchema.parse()` at every ingress point.
    Specifically:
    - Server endpoints parse incoming requests with Zod before processing.
    - `SyncNode` parses incoming messages from the server with Zod after
      decryption — malformed messages are rejected, not silently accepted.
    - CLI mappers validate their output against `MessageWithPartsSchema`
      before sending — if the mapper produces garbage, it fails loud.
    - Token claims are parsed with Zod on creation and on every server
      request.
    - Socket.IO event payloads are Zod-validated on receipt.
    - The app does NOT trust the sync layer implicitly — it receives
      already-parsed typed data from `SyncNode`, which did the validation.

---

## Architecture

### Package: `happy-sync`

```
packages/happy-sync/src/
  protocol.ts          # v3 Zod schemas (MessageWithParts, Part, ToolState, Block, SessionInfo, etc.)
  protocol.test.ts     # schema validation tests
  sync-node.ts         # SyncNode class — connection, encrypt, send, receive, state
  sync-node.test.ts    # unit tests for state transitions, dedup, seq tracking
  encryption.ts        # encrypt/decrypt message content
  index.ts             # public API exports
```

### Sessions and Child Sessions

A **session** is both the conversation and the sync scope: one authenticated
connection, one set of encryption keys, one `SyncNode`. It maps to a user +
machine + project.

Subagents create **child sessions** within the same account, linked via
`parentID` on `SessionInfo` (which already exists in the current protocol
types). This matches OpenCode's model exactly. Child sessions have their
own messages, permissions, questions, and status — fully independent
conversations with their own `SyncNode` in the agent process.

```
Account
  ├── Session abc (root — main conversation, all 34 exercise-flow steps)
  │     ├── Message (user): "Use a subagent to explore keyboard events..."
  │     ├── Message (assistant): [subtask part → links to child session]
  │     └── ...
  ├── Session def (child of abc — subagent: "explore keyboard events")
  │     ├── Message (assistant): [tool parts: file reads]
  │     └── Message (assistant): [text: summary]
  └── Session ghi (child of abc — subagent: "check accessibility issues")
        ├── Message (assistant): [tool parts: file reads]
        └── Message (assistant): [text: summary]
```

The parent session's transcript contains a `subtask` part that links to
the child session's ID. The app discovers child sessions via these links.

### State Model

```ts
interface SessionState {
  info: SessionInfo;           // includes parentID for child sessions
  messages: MessageWithParts[];

  // Derived from messages by SyncNode — not independently tracked
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  status: SessionStatus;
}

interface SyncState {
  sessions: Map<SessionID, SessionState>;
}
```

All derived fields (`permissions`, `questions`, `todos`, `status`) are
computed by SyncNode from scanning `messages`. They are convenience
accessors, not independent state. Messages are the single source of truth.

All types are strongly typed with branded IDs from the protocol Zod schemas.
No `Record<string, unknown>`. No untyped dictionaries. `SessionInfo` already
has `parentID: SessionID.optional()` for child sessions.

### Server Model

The server is a **dumb encrypted pipe**. It never decrypts message content.
It never parses `MessageWithParts`. It stores:

```
sessionMessage {
  id: string
  sessionId: string
  seq: number              // monotonically increasing per session
  content: string          // encrypted blob (base64 ciphertext)
  localId: string          // client-generated, for dedup
  createdAt: timestamp
  updatedAt: timestamp
}
```

The CLI **patches messages in-place** as tool states evolve. When a tool
transitions from `blocked` → `running` → `completed`, the CLI re-encrypts
the updated `MessageWithParts` and sends it as a message update. The server
stores the new ciphertext. Consumers fetch and decrypt to get the latest
state. This is how it already works in the v3 rewrite.

### SyncNode

```ts
class SyncNode {
  readonly state: SyncState;

  constructor(opts: {
    serverUrl: string;
    token: SyncNodeToken;      // JWT with claims (scope, permissions)
    keyMaterial: KeyMaterial;   // encryption keys
  });

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): void;

  // Session operations (account-scoped only — type-enforced)
  createSession(opts: CreateSessionOpts): Promise<SessionID>;
  listSessions(): SessionInfo[];
  stopSession(sessionId: SessionID): Promise<void>;

  // Message operations
  sendMessage(sessionId: SessionID, message: MessageWithParts): Promise<void>;
  updateMessage(sessionId: SessionID, message: MessageWithParts): Promise<void>;
  approvePermission(sessionId: SessionID, requestId: string, opts?: ApproveOpts): Promise<void>;
  denyPermission(sessionId: SessionID, requestId: string, opts?: DenyOpts): Promise<void>;
  answerQuestion(sessionId: SessionID, questionId: string, answers: string[][]): Promise<void>;

  // Observation
  onStateChange(callback: (state: SyncState) => void): () => void;
  onMessage(sessionId: SessionID, callback: (message: MessageWithParts) => void): () => void;

  // Internal (called automatically, exposed for testing)
  fetchMessages(sessionId: SessionID, afterSeq?: number): Promise<void>;
  flushOutbox(): Promise<void>;
}
```

Note `updateMessage()` — the CLI patches messages in-place as tool states
evolve. This sends the re-encrypted updated `MessageWithParts` to the server,
which overwrites the ciphertext for that message's seq.

### Token Claims

```ts
interface SyncNodeToken {
  raw: string;   // JWT string
  claims: {
    scope:
      | { type: 'account'; userId: string }
      | { type: 'session'; userId: string; sessionId: SessionID };
    permissions: ('read' | 'write' | 'admin')[];
  };
}
```

Session-scoped tokens restrict all operations to that session. Account-scoped
tokens can operate on any session the user owns. The server validates claims
on every request. `SyncNode` can introspect its own token to know what it's
authorized to do.

### Who Uses What

| Consumer                  | Token Scope | What it does                                              |
|---------------------------|-------------|-----------------------------------------------------------|
| CLI session (Claude)      | session     | Mapper reads `node.state`, applies agent event, writes back via `node.updateMessage()`. |
| CLI session (Codex)       | session     | Same, different mapper.                                   |
| CLI session (OpenCode)    | session     | Same, different mapper.                                   |
| Daemon                    | account     | `createSession()`, `listSessions()`, `stopSession()`.     |
|                           |             | Spawns CLI session processes. Does NOT hold message state. |
| React Native app          | account     | Reads all sessions. Renders `MessageWithParts` directly.  |
| Integration tests         | account     | Full programmatic access. Drives the exercise flow.       |

### Process Model

```
Daemon process
  └─ Account-scoped SyncNode (lifecycle only — create/list/stop sessions)
       │
       ├─ Spawns: Claude session process
       │    └─ Session-scoped SyncNode (sessionID: abc)
       │         └─ Claude mapper: reads node.state → applies SDK event → node.updateMessage()
       │
       ├─ Spawns: Codex session process
       │    └─ Session-scoped SyncNode (sessionID: def)
       │         └─ Codex mapper: reads node.state → applies event → node.updateMessage()
       │
       └─ Spawns: OpenCode session process
            └─ Session-scoped SyncNode (sessionID: ghi)
                 └─ OpenCode mapper: reads node.state → applies event → node.updateMessage()

App process (separate, on user's phone/browser)
  └─ Account-scoped SyncNode
       └─ syncNode.state.sessions → Zustand store → React renders
          MessageWithParts directly (Part → component, no conversion)

Integration tests
  └─ Account-scoped SyncNode (programmatic, no subprocess)
       └─ createSession → sendMessage → read state → assert
```

### Data Flow

```
Provider SDK output (Claude JSON / Codex events / OpenCode events)
  │
  ▼
Provider mapper (happy-cli, per-agent) — STATELESS
  │  1. reads current message from syncNode.state
  │  2. applies agent event as a delta (new part, state transition, text append)
  │  3. returns updated MessageWithParts
  ▼
Session-scoped SyncNode (happy-sync)
  │  node.updateMessage(sessionId, updatedMessage)
  │  encrypts, queues, flushes via HTTP POST
  ▼
Server (happy-server)
  │  stores encrypted blob, assigns seq, pushes Socket.IO notification
  ▼
Account-scoped SyncNode (happy-sync, in app or test)
  │  receives notification, fetches, decrypts, merges into state
  ▼
SyncState.sessions.get(sessionID).messages: MessageWithParts[]
  │
  ▼
UI renders Part directly (no conversion)
  text part     → TextPartView
  tool part     → ToolPartView
  reasoning part → ReasoningPartView
  subtask part  → SubtaskPartView (links to child session via parentID)
  etc.
```

No conversion. No intermediate types. The type that enters the pipeline is
the type that renders on screen.

### Mapper Model

The mapper is a **stateless pure function**: `(currentMessage, agentEvent) →
updatedMessage`. It does NOT maintain its own state. All state lives in
`SyncNode`:

```ts
// Mapper signature (conceptual — each agent has its own)
function applyAgentEvent(
  current: MessageWithParts | null,  // from syncNode.state, null for first message
  event: AgentEvent,                 // from provider SDK
): MessageWithParts;

// Usage in CLI session process
agentSDK.on('event', (event) => {
  const sessionState = syncNode.state.sessions.get(sessionId);
  const currentMsg = sessionState?.messages.at(-1) ?? null;
  const updated = applyAgentEvent(currentMsg, event);
  syncNode.updateMessage(sessionId, updated);
});
```

This means:
- **SyncNode is the single source of truth** for all session state. Messages,
  permissions, todos, status — everything is derived from the messages that
  SyncNode holds.
- **Mappers have zero side state.** They read from SyncNode, transform, write
  back. If the process crashes and restarts, SyncNode rehydrates from the
  server and the mapper picks up where it left off — there's nothing to
  reconstruct.
- **Session state (permissions, todos, status) is derived by SyncNode** from
  scanning its messages. The existing mapper tests remain valid — they test
  the transformation logic. But the mapper no longer "owns" the message
  being built; it borrows it from SyncNode and returns the update.

---

## Testing

Four levels. All must pass. No shortcuts.

### Level 0: Unit Tests (pure functions, instant)

**What:** Protocol schema validation, mapper state machines, encryption
round-trips.

**Where:**
- `happy-sync/src/protocol.test.ts` — Zod schema validation for all types
- `happy-cli/src/claude/utils/v3Mapper.test.ts` — Claude mapper
- `happy-cli/src/codex/utils/v3Mapper.test.ts` — Codex mapper
- `happy-cli/src/opencode/utils/v3Mapper.test.ts` — OpenCode mapper (when built)
- `happy-sync/src/sync-node.test.ts` — state transitions, dedup, seq logic

**What they cover:**
- Every Zod schema validates correct input and rejects malformed input.
  All 12 part types, all 5 tool states, all block types, resolved block
  variants, session info, envelope versioning.
- Claude mapper: basic text turn, reasoning, tool calls, tool errors,
  multi-step turns, token accumulation, system/summary messages, part
  ordering, permission blocking (approve/reject), question blocking
  with answers, flush behavior.
- Codex mapper: `task_started`, `agent_message`, `exec_command_begin/end`,
  `patch_apply_begin/end`, `exec_approval_request`, `apply_patch_approval`,
  synthetic tool-call events, error paths, reasoning coalescing, section breaks.
- SyncNode state: message insert, update, dedup by localId, seq ordering,
  permission/question add/resolve — no transport, just state mutation methods.

**Runs:** Every commit. Instant.

### Level 1: Sync Engine Integration Tests

**What:** Tests `SyncNode` transport + encryption. Real server, real crypto,
synthetic `MessageWithParts`. No LLM. Runs in seconds.

**Setup:** Boot a real happy-server (in-process or subprocess with test DB).
Create two `SyncNode` instances — one acting as producer (CLI-side), one
acting as consumer (app-side). Feed synthetic messages through one, verify
they arrive on the other.

**Must cover:**
- [ ] **Message round-trip** — send a `MessageWithParts` through producer
  node, verify it arrives intact on consumer node's `state`.
- [ ] **Encryption** — content survives encrypt → server store → fetch →
  decrypt. Verify ciphertext stored on server is not plaintext.
- [ ] **Seq ordering** — messages arrive in send order. Seq numbers are
  monotonically increasing.
- [ ] **Dedup** — same `localId` sent twice does not create duplicate message.
- [ ] **Batching** — outbox flushes multiple messages in one POST when
  available.
- [ ] **Pagination** — 50+ messages fetch correctly via cursor. All messages
  eventually arrive.
- [ ] **Real-time push** — Socket.IO `new-message` → immediate state update
  on consumer, without polling.
- [ ] **Reconnect** — disconnect consumer, send messages via producer,
  reconnect consumer, verify all messages arrive via hydration.
- [ ] **Session isolation** — messages to different sessions don't leak.
  Child sessions (subagents) have their own `SessionState`.
- [ ] **Permission state round-trip** — tool with `blocked` state → resolve
  with `decision: 'once'` → `ResolvedPermissionBlock` survives full
  encrypt → store → fetch → decrypt cycle.
- [ ] **Question state round-trip** — tool with `blocked` question → answer →
  `ResolvedQuestionBlock` survives full cycle.
- [ ] **Concurrent sessions** — two session-scoped nodes for different
  sessions on same account. Messages don't leak between sessions.
- [ ] **Account-scoped operations** — create session, list sessions, stop
  session via account-scoped node.
- [ ] **Session-scoped restriction** — session-scoped node cannot access
  other sessions, cannot create sessions.

**Where:** `happy-sync/src/sync-node.integration.test.ts`

**Runs:** Every PR. Takes seconds, no LLM cost.

### Level 2: End-to-End Agent Flow (exercise-flow.md)

The most important test. One long, sequential flow per agent type. Real LLMs,
real server, real provider CLIs. `SyncNode` drives execution programmatically.

**This test must cover ALL 34 steps of exercise-flow.md.** No steps skipped.
No steps simplified. Each step must have explicit assertions. If the exercise
flow grows beyond 34 steps, the tests must grow to match.

The test uses an **account-scoped `SyncNode`** to:
- Create sessions
- Send user messages to sessions
- Read state (messages, permissions, questions, todos) directly from
  `syncNode.state.sessions.get(id).messages`
- Approve/deny permissions
- Answer questions

Assertions verify **structural outcomes**, not LLM prose. The LLMs are smart;
the steps are designed to produce deterministic protocol behavior:

#### SETUP
- [ ] **Step 0** — Session created, agent process spawns, session appears in
  `syncNode.state.sessions`.

#### TRANSCRIPT
- [ ] **Step 1 — Orient** — Send "Read all files, tell me what this does."
  Verify: at least one assistant message with completed tool parts (file
  reads) and text parts. `step-start` and `step-finish` present.
  `providerID` set correctly.
- [ ] **Step 2 — Find the bug** — Send "There's a bug in the Done filter..."
  Verify: assistant message with text parts. No tool calls that modify
  files. Text mentions the bug area (filter/done).

#### PERMISSIONS
- [ ] **Step 3 — Edit rejected** — Send "Fix it." Wait for permission request
  in session state. Deny it. Verify: tool part transitions to `error`
  with `block.decision === 'reject'`.
- [ ] **Step 4 — Edit approved once** — Send "Ok apply the fix." Wait for
  permission. Approve once. Verify: tool part `completed` with
  `block.decision === 'once'`. File changed on disk.
- [ ] **Step 5 — Edit approved always** — Send dark mode request. Wait for
  permission. Approve always with tool allowlist. Verify: tool part
  `completed`. Allow-always rule stored.
- [ ] **Step 6 — Auto-approved** — Send multi-file edit request. Verify: NO
  permission prompt (auto-approved by step 5 rule). Tool parts `completed`
  without `block` field. Multiple files changed on disk.

#### WEB SEARCH
- [ ] **Step 7 — Search the web** — Send web search request. Verify:
  assistant message contains a web search/fetch tool part that completed.

#### SUBAGENTS
- [ ] **Step 8 — Parallel explore** — Send subagent request. Verify: subtask
  parts appear in parent session. Child sessions created with `parentID`
  pointing to parent session. Child sessions have their own messages with
  tool parts. Parent session gets summary text after children complete.

#### TOOLS
- [ ] **Step 9 — Simple edit** — Send simple edit request. Verify: tool part
  completed (auto-approved or prompted depending on agent). File changed.

#### INTERRUPTION
- [ ] **Step 10 — Cancel** — Send complex request, then cancel/interrupt
  mid-stream. Verify: partial response exists. No half-written corrupt
  files (or if tool was mid-execution, state reflects cancellation).
- [ ] **Step 11 — Resume after cancel** — Send simpler follow-up. Verify:
  agent completes it cleanly. New assistant message with completed tool.

#### QUESTION
- [ ] **Step 12 — Agent asks a question** — Send "Add a test framework. Ask
  me which one." Verify: question appears in session state. Question has
  options. Answer "Vitest". Verify: question resolved.
- [ ] **Step 13 — Act on the answer** — Send "Set up Vitest." Verify:
  multiple files created. Tool parts completed.

#### SANDBOX
- [ ] **Step 14 — Read outside project** — Send "What files are in the parent
  directory?" Record behavior (may succeed, may be denied). Either way,
  verify the response has appropriate structure.
- [ ] **Step 15 — Write outside project** — Send "Create ../outside-test.txt".
  Verify: blocked, denied, or error. File does NOT exist outside project.

#### TODO
- [ ] **Step 16 — Create todos** — Send todo creation request. Verify: todos
  appear in session state. At least 3 items with `pending` status.

#### MODEL SWITCH
- [ ] **Step 17 — Switch and edit** — Switch model (via whatever mechanism the
  agent supports). Send edit request. Verify: assistant message has
  different `modelID` or `providerID` than earlier messages. Tool part
  completed. File changed.

#### COMPACTION
- [ ] **Step 18 — Compact** — Trigger compaction. Verify: compaction part
  appears in the transcript.
- [ ] **Step 19 — Post-compaction sanity** — Send "What files have we changed?"
  Verify: agent produces a text response referencing prior work. Session
  still functional after compaction.

#### PERSISTENCE
- [ ] **Step 20 — Close** — Stop the agent session process.
- [ ] **Step 21 — Reopen** — Resume/reopen the session. Verify: all prior
  messages still present in `syncNode.state`. Message count matches
  pre-close count. Child sessions still linked via `parentID`.
- [ ] **Step 22 — Verify continuity** — Send "What was the last thing we were
  working on?" Verify: agent references prior work.

#### TODO (continued)
- [ ] **Step 23 — Mark todo done** — Send "Mark 'add due dates' as completed."
  Verify: todo item status changes to `completed` in session state.

#### MULTI-PERMISSION
- [ ] **Step 25 — Multiple permissions in one turn** — Send a refactoring
  request that touches multiple files. Agent produces multiple blocked
  tools. Approve each individually (once). Verify: all permission prompts
  appear, each resolved independently, agent waits for ALL before
  continuing. Multiple completed tools with `block.decision === 'once'`.
- [ ] **Step 26 — Supersede pending permissions** — Send a new message while
  permissions from step 25 may still be pending (or immediately after).
  Verify: any pending permissions are auto-rejected (`block.decision ===
  'reject'`, reason indicates superseded). Agent starts fresh with new
  request.

#### SUBAGENT PERMISSIONS
- [ ] **Step 27 — Subagent hits permission wall** — Send request that spawns
  a subagent needing edit permission. Permission appears in child session
  state. Approve in child session. Verify: child session completes, parent
  session's subtask part resolves.

#### STOP WITH PENDING STATE
- [ ] **Step 28 — Stop while permission pending** — Send edit request. When
  permission appears, stop the session entirely (kill process). Verify:
  pending permissions auto-rejected on stop. No stuck blocked tools.
  Session state clean.
- [ ] **Step 29 — Resume after forced stop** — Resume session. Send "What
  happened?" Verify: agent sees rejected tools from forced stop. History
  intact. Agent explains what happened.
- [ ] **Step 30 — Retry after stop** — Send retry request, approve
  permissions this time. Verify: agent completes cleanly after previous
  forced stop.

#### BACKGROUND TASKS
- [ ] **Step 31 — Launch background task** — Send "Run a background task
  that sleeps for 30 seconds and echoes 'lol i am donezen'. While it's
  running, tell me what time is it." Verify: tool part appears in
  `running` state. Agent responds to the time question without waiting
  for the background task. Two things happen concurrently.
- [ ] **Step 32 — Background completes** — Wait ~30 seconds. Send "Did
  that background task finish?" Verify: tool part transitioned to
  `completed` with output containing "lol i am donezen". Time gap
  between start and end ~30 seconds.
- [ ] **Step 33 — Foreground + background concurrent** — Send "Run
  another background: sleep 20 && echo 'background two'. While that
  runs, add a comment to the top of app.js." Verify: two tool parts —
  one `running` (background), one `completed` (edit). Edit happens
  immediately. Background completes later. File changed on disk.

#### WRAP UP
- [ ] **Step 34 — Full summary** — Send "Give me a git-style summary." Verify:
  text response present. This is the capstone — if the agent produces a
  coherent multi-step summary, the transcript held together through all
  34 steps.

#### Cross-cutting assertions (checked at the end)
- [ ] **No legacy envelopes** — zero messages with `role: 'session'` in
  history. All messages are `MessageWithParts`.
- [ ] **All assistant messages structurally valid** — every assistant message
  has `step-start`, at least one content part, and `step-finish`.
- [ ] **Permission decisions survive round-trip** — every resolved block has
  `type`, `decision`/`answers`, and `decidedAt` after JSON
  serialization → server → deserialization.
- [ ] **Message count is sane** — no duplicates (unique IDs), messages in
  seq order.
- [ ] **All tool parts have terminal state** — every tool part is `completed`
  or `error` (none stuck in `pending`, `running`, or `blocked`).
- [ ] **Child session structure intact** — child sessions (from step 8) have
  `parentID` pointing to the root session. Subtask parts in the parent
  session link to the correct child session IDs.

#### Per-agent variants

The same 34-step flow runs for each supported agent. Steps may behave
differently per agent — some support subagents, some don't; permissions work
differently; etc. The test accounts for this:

- [ ] **Claude** — full 34 steps. Subagents supported. Plan mode supported.
  Permission model: Claude's built-in permission handler.
- [ ] **Codex** — full 34 steps. Subagents may not apply (steps 8, 27
  recorded as "not applicable" with reason). Permission model: Codex
  approval system mapped to blocks.
- [ ] **OpenCode** — full 34 steps (when adapter exists). Permission model:
  OpenCode's permission side-channel mapped to blocks.

Steps that don't apply to a given agent are **recorded as "not applicable"
with the reason**, NOT silently skipped or removed.

**Where:**
- `happy-sync/src/e2e/claude.integration.test.ts`
- `happy-sync/src/e2e/codex.integration.test.ts`
- `happy-sync/src/e2e/opencode.integration.test.ts`

**Runs:** Nightly or on-demand. Costs money (real LLM calls), takes minutes.

### Level 3: Agent-Driven Browser/UX Verification

A coding agent walks the web UI using `agent-browser`, verifying that the
rendered transcript matches a UX capability spec. Screenshots are captured
and read natively by the coding agent (multimodal image reading).

- [ ] **Uses `agent-browser`** for browser automation — `open`, `snapshot`
  (accessibility tree), `click`, `fill`, `screenshot`.
- [ ] **Reads screenshots natively** — the coding agent views captured PNG
  images to verify visual correctness, layout, readability. Not just DOM
  text — actual visual judgment.
- [ ] **`agent-browser snapshot`** for accessibility tree — structured text
  representation of what's on the page.
- [ ] **UX capability spec is markdown** — `environments/lab-rat-todo-project/ux-spec.md`
  defines what should be visible/invisible at each step of the exercise flow.
  This is the source of truth for what "renders correctly" means.
- [ ] **Covers all 34 steps** — after the Level 2 test completes a full agent
  flow, the browser test opens that session and walks the rendered
  transcript, verifying each step rendered correctly.

Per-step browser assertions (representative, not exhaustive):

- [ ] User messages render as user bubbles with the original text.
- [ ] Assistant text renders as formatted markdown, not raw JSON.
- [ ] Tool calls render with clean titles and expandable output — no raw
  `tool_use_id`, `parent_tool_use_id`, `call_id`, or provider-native
  JSON visible.
- [ ] Codex-specific: no `exec_command_begin`, `exec_command_end`,
  `patch_apply_begin`, `patch_apply_end` raw events visible.
- [ ] Permission prompts render with approve/deny UI and tool description.
  Resolved permissions show the decision.
- [ ] Questions render with the options and the user's answer.
- [ ] Subagent sessions render as collapsible sections with their own
  transcript. Links from parent subtask part to child session work.
- [ ] Compaction markers render appropriately (not as raw JSON).
- [ ] Todos render as a checklist with correct statuses.
- [ ] Session is scrollable, all 34 steps present in order.
- [ ] No raw JSON blobs anywhere in the visible transcript.
- [ ] Screenshots at key moments are visually correct — layout not broken,
  text readable, no overlapping elements. The agent reads these as images
  and judges.

**Where:** `environments/lab-rat-todo-project/ux-spec.md` (spec),
invoked via `agent-browser` during or after Level 2 tests.

**Runs:** On-demand, as final QA gate before release.

---

## What Changes

### New

| Path | What |
|------|------|
| `packages/happy-sync/` | Renamed from `happy-wire` + `SyncNode` + encryption |
| `packages/happy-sync/src/sync-node.ts` | The single sync primitive |
| `packages/happy-sync/src/sync-node.test.ts` | Level 0 state unit tests |
| `packages/happy-sync/src/sync-node.integration.test.ts` | Level 1 sync engine tests |
| `packages/happy-sync/src/e2e/` | Level 2 per-agent flow tests |
| `environments/lab-rat-todo-project/ux-spec.md` | Level 3 browser spec |

### Moves

| From | To | Notes |
|------|------|-------|
| `packages/happy-wire/` | `packages/happy-sync/` | Rename, keep protocol types |
| `happy-cli` encryption logic | `happy-sync/src/encryption.ts` | Single encryption impl |
| `happy-cli/src/api/apiSession.ts` transport | `happy-sync/src/sync-node.ts` | HTTP, Socket.IO, outbox, state |
| `happy-agent/` lifecycle commands | Daemon | Daemon absorbs session lifecycle |

### Deletes

| Path | Why |
|------|------|
| `happy-app/sources/sync/v3Converter.ts` | No conversion — UI renders `MessageWithParts` |
| `happy-app/sources/sync/v3Converter.test.ts` | Same |
| `happy-app/sources/sync/v3Protocol.integration.test.ts` | Superseded by Level 1 + 2 |
| `happy-app/sources/sync/storageTypes.ts` (Message kinds) | Replaced by protocol types |
| `happy-cli/src/claude/utils/v3Mapper.wiring.test.ts` | Wiring tested by Level 2 |
| `happy-agent/` (entire package) | Absorbed into daemon + `SyncNode` |
| Legacy reducer code in `happy-app/sources/sync/sync.ts` | No legacy path |

### Stays

| Path | Why |
|------|------|
| `happy-cli/src/claude/utils/v3Mapper.ts` + test | Stateless: `(currentMsg, sdkEvent) → updatedMsg` |
| `happy-cli/src/codex/utils/v3Mapper.ts` + test | Stateless: `(currentMsg, event) → updatedMsg` |
| `happy-sync/src/protocol.ts` + test | Source of truth types |
| `exercise-flow.md` | Source of truth for Level 2 + 3 |
| `happy-server` v3 routes | Unchanged — dumb encrypted pipe |

---

## Protocol Types

The existing v3 `MessageWithParts` model stays. It's well-designed. Key
types for reference:

- `MessageInfo` = `UserMessage | AssistantMessage` (discriminated on `role`)
- `Part` = discriminated union of 12 types: `text`, `reasoning`, `tool`,
  `file`, `step-start`, `step-finish`, `subtask`, `agent`, `snapshot`,
  `patch`, `compaction`, `retry`
- `ToolState` = state machine: `pending → running → completed`, with
  `running → blocked → running → completed` and `blocked → error (rejected)`
- `Block` = `PermissionBlock | QuestionBlock`, resolved variants carry
  `decision`/`answers` + `decidedAt`
- `ProtocolEnvelope` = `{ v: 3, message: MessageWithParts }`
- `SessionInfo` — already has `parentID: SessionID.optional()` for child
  sessions (subagents). No new types needed for the session hierarchy.

### New part types

Permissions and questions are resolved by sending **decision/answer messages**
into the session — same encrypted channel, no RPC.

```ts
// User sends this to resolve a permission
const DecisionPartSchema = PartBaseSchema.extend({
  type: z.literal('decision'),
  targetMessageID: MessageID,
  targetCallID: z.string(),
  permissionID: z.string(),
  decision: z.enum(['once', 'always', 'reject']),
  allowTools: z.array(z.string()).optional(),  // for 'always'
  reason: z.string().optional(),               // for 'reject'
  decidedAt: z.number(),
});

// User sends this to answer an agent question
const AnswerPartSchema = PartBaseSchema.extend({
  type: z.literal('answer'),
  targetMessageID: MessageID,
  targetCallID: z.string(),
  questionID: z.string(),
  answers: z.array(z.array(z.string())),
  decidedAt: z.number(),
});
```

### Permission resolution rules

- **Multiple blocked tools in one turn** — each resolved independently via
  separate decision messages. CLI waits for ALL to resolve before continuing.
  An "always" decision auto-resolves other matching blocked tools.
- **New user message supersedes pending permissions** — if the user sends a
  regular text message while permissions are pending, CLI auto-rejects all
  pending permissions and starts a new turn.
- **Session stop auto-rejects** — stopping the session auto-rejects all
  pending permissions with reason "session stopped".
- **Child session permissions stay in child session** — the app sends
  decision messages into the child session, not the parent.

### Session snapshot (derived state)

The CLI maintains a **session snapshot** — a lightweight summary of session
state (pending permissions, todos, status) derived from scanning all local
messages. This snapshot is pushed to the server as a separate encrypted
message with a known localId (e.g. `snapshot:{sessionId}`), patched in
place on every state change. The app uses this for session list rendering
without loading full message history. Messages remain the source of truth;
the snapshot is a cache that can be rebuilt.

---

## Implementation Order

### Already proven (from failed `messaging-protocol-v3` branch)

These artifacts have passing unit tests and are carried forward as-is:

- `packages/happy-wire/src/protocol.ts` — v3 Zod schemas (MessageWithParts,
  Part, ToolState, Block types). 21 passing tests.
- `packages/happy-cli/src/claude/utils/v3Mapper.ts` — Claude SDK →
  MessageWithParts mapper. 18 passing tests.
- `packages/happy-cli/src/codex/utils/v3Mapper.ts` — Codex → MessageWithParts
  mapper. 18 passing tests.
- `environments/lab-rat-todo-project/exercise-flow.md` — 34-step exercise flow.

### Build order

1. Rename `happy-wire` → `happy-sync`, update all imports across monorepo.
   Protocol types and existing Level 0 tests move with it.
2. Build `SyncNode` — extract transport/encryption from `apiSession.ts`,
   implement state management (`SyncState` with `SessionState`),
   Socket.IO connection, outbox, pagination, reconnect, message patching.
3. Level 0 tests — SyncNode state unit tests (add to existing protocol/mapper
   tests that already pass).
4. Level 1 tests — sync engine integration (real server, synthetic messages).
   **This is where the failed branch never got.** SyncNode as programmatic
   test harness — no subprocess, no CLI binary, no execFileSync.
5. Wire CLI session processes to use session-scoped `SyncNode` (mappers feed
   into `node.sendMessage()`).
6. Wire daemon to use account-scoped `SyncNode` for lifecycle.
7. Wire app to use account-scoped `SyncNode`. App store holds `SessionState`
   from `SyncNode.state`. React components render `Part` directly — kill the
   converter, kill the legacy reducer, kill the intermediate type system.
8. Absorb `happy-agent` into daemon + `SyncNode` test harness.
9. Level 2 tests — full 34-step exercise flow per agent type.
10. Write `ux-spec.md`. Level 3 browser verification via `agent-browser`.
11. Delete dead code — converters, legacy types, `happy-agent` package,
    legacy sync code, `HAPPY_V3_PROTOCOL` env var, dual-write paths.

---

## Resolved Questions

1. **Child session encryption** — child sessions share the parent's
   encryption key. Same key material, simpler.

2. **Token delivery** — environment variable. The daemon passes the
   session-scoped JWT to the spawned CLI process via env var.

3. **Message patching** — full re-send of the encrypted message. The server
   stores encrypted blobs — it can't patch ciphertext. CLI re-encrypts the
   full updated `MessageWithParts` and sends it. Simple, no partial update
   mechanism needed.

4. **UX spec** — `exercise-flow.md` IS the UX spec. No separate file. The
   exercise flow already defines what should happen at each step; the browser
   verification uses the same document as its source of truth.

5. **Session-level state** — session state (permissions, todos, status) is
   derived by the CLI from all messages and pushed as a session snapshot
   (cache). The app can fetch just the snapshot for session lists without
   loading all messages. Messages remain the source of truth; the snapshot
   is a cache that can be rebuilt. This resolves the "Option A vs Option B"
   question: it's both — messages are the source of truth (Option A), but
   a derived snapshot is pushed to the server for lazy loading (Option B).

6. **Subagents are child sessions** — not threads. `SessionInfo` already has
   `parentID: SessionID.optional()`. No separate thread concept needed.

7. **Permission/question resolution** — via decision/answer messages sent
   into the session (new `decision` and `answer` part types on user
   messages). No RPC. The CLI watches for these messages and acts on them.

8. **Token delivery to CLI session processes** — environment variable.
   The daemon passes the session-scoped JWT to the spawned CLI process
   via env var.

## Open Questions

None. All questions resolved — see "Resolved Questions" above.

---

## Lessons from the Failed v3 Attempt

Branch `messaging-protocol-v3` was the first attempt at this migration. A
Codex agent ran in a loop for 15 iterations (~8 hours), producing +3,400
lines of code changes across 29 files. **The unit tests pass (57 tests).
The integration tests never once ran to completion.** Across 155 launches,
zero produced a result. They got killed by timeouts, stuck on environment
boot, or hung waiting for agent responses.

### Why it failed

The integration test architecture was fundamentally broken:

1. **Subprocess-based test driving** — tests drove everything via
   `execFileSync(binPath, ['send', ...])` and `execFileSync(binPath,
   ['history', ...])`, spawning the `happy-agent` CLI binary for every
   operation. This meant every assertion required:
   - Spawning a child process
   - Waiting for it to boot
   - Parsing JSON output from stdout
   - Hoping it doesn't hang or timeout
   There was no shared programmatic API. State was read by shelling out.

2. **Fragile environment setup** — `yarn env:up:authenticated` boots a full
   server + app + CLI daemon. Too many moving parts. Any one of them failing
   to start, starting slowly, or hanging on auth would kill the test run.

3. **No shared sync primitive** — the CLI, app, and tests all had their own
   bespoke transport code. The test harness (`happy-agent`) was a separate
   package with its own binary, its own session client, its own auth flow —
   all duplicating what the daemon already does.

4. **Too many layers of indirection** — test → subprocess → CLI binary →
   daemon → server → app. Any layer could hang, timeout, or fail silently.
   The e2e test strategy was doomed by architecture, not code quality.

### What the new approach fixes

- **`SyncNode` is the programmatic test harness.** Integration tests
  instantiate `SyncNode` directly. No CLI binary. No `execFileSync`. No
  parsing JSON from stdout. Tests call `node.sendMessage()` and read
  `node.state` — same API the production code uses.
- **No `happy-agent` package.** The daemon absorbs lifecycle. Tests use
  `SyncNode`. The entire indirection layer is gone.
- **Level 1 tests run in seconds.** Real server, synthetic messages, no LLM.
  SyncNode ↔ server ↔ SyncNode. If this layer breaks, we know immediately.
- **Level 2 tests add LLMs on top of a proven transport.** By the time we
  run real agents, we already know SyncNode, encryption, and the server work.
  The only variable is agent behavior — which is what we actually want to
  test.

### What was salvaged

- Protocol types (`protocol.ts`) — 21 passing tests. Well-designed Zod
  schemas. Carried forward as-is.
- Claude mapper (`v3Mapper.ts`) — 18 passing tests. State machine logic for
  tool tracking, permission blocking, question handling is correct.
- Codex mapper (`v3Mapper.ts`) — 18 passing tests. Handles all Codex event
  types correctly.
- Exercise flow (`exercise-flow.md`) — expanded to 34 steps. The flow design
  is good; only the test execution strategy was wrong.

### Lesson for future agents

If you are an AI agent reading this spec: **do not attempt subprocess-based
integration testing.** A prior agent spent 8 hours in a loop trying to make
it work. It cannot work with this architecture. Use `SyncNode` directly.
The API is `node.sendMessage()` / `node.state` / `node.onStateChange()`.
That is the only integration test strategy that will succeed.

---

## What We Are NOT Doing

- ~~Backwards compatibility with legacy message formats~~ — full migration
- ~~Converter from `MessageWithParts` to flat app types~~ — UI renders directly
- ~~`happy-agent` as a separate package~~ — absorbed into daemon
- ~~Multiple transport abstractions~~ — Socket.IO only
- ~~Snapshot-based browser testing~~ — agent-driven with multimodal reads
- ~~Mocked LLM tests as primary coverage~~ — real LLMs are the primary test
- ~~State held in daemon~~ — daemon is lifecycle only, no message state
- ~~Untyped dictionaries for state~~ — strongly typed Maps with branded IDs
- ~~Feature flags for protocol version~~ — v3 only, no `HAPPY_V3_PROTOCOL`
- ~~Separate "thread" concept~~ — sessions are conversations, child sessions
  are subagents (matches OpenCode)
- ~~Server parsing message content~~ — server is a dumb encrypted pipe
