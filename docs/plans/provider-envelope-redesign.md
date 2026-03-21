# Provider Envelope Redesign

Status: **DRAFT**

## Why this exists

The current inner message layer has become too hard to reason about.

Today the app must normalize multiple plaintext payload families after decryption:

- legacy user messages
- legacy agent `output` messages
- legacy `codex` messages
- legacy `acp` messages
- legacy `event` messages
- modern `role: "session"` envelopes

That fan-in is visible in [`packages/happy-app/sources/sync/typesRaw.ts`](../../packages/happy-app/sources/sync/typesRaw.ts), and it is the real source of the complexity.

The problem is no longer transport. The transport story is mostly fine:

- encrypted blobs in storage
- ordered per-session messages
- v3 HTTP read/write with Socket.IO invalidation

The messy part is the **provider envelope shape inside the encrypted message body**.

This document proposes a simpler replacement for the current "session protocol" direction.

## Branch findings

We checked both the committed branch history and the dirty linked worktree for `p6-message-envelope-v2`.

- The committed branch history does **not** contain unique session-redesign commits. The three commits on that branch but not on `main` are media-only work.
- The actual envelope redesign work lives in the **dirty worktree**, not in committed history.
- That work is still useful because it already proves several cleanup moves end to end:
  - flatten nested `ev.t` into top-level `type`
  - remove the outer `role: "session"` wrapper and send direct envelope records
  - replace `subagent` with `parentId` plus `agentId`
  - make `permission-request` and `permission-response` transcript events
  - add direct media event variants (`photo`, `video`, `file`)
  - update app normalization and reducer logic to consume direct transcript permissions

Relevant files touched in that worktree:

- `packages/happy-wire/src/sessionProtocol.ts`
- `packages/happy-wire/src/messages.ts`
- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`
- `packages/happy-app/sources/sync/typesRaw.ts`
- `packages/happy-app/sources/sync/reducer/reducer.ts`

For planning purposes, we should treat the p6 worktree as a **prototype / proof of direction**, not as committed design history.

## Problems with the current design

### 1. We are mixing transport concerns with provider event concerns

The name "session protocol" encourages us to design a big umbrella format for everything.

But the transport layer already exists:

- database row
- encrypted container
- session-scoped ordering
- sync/update delivery

What we actually need here is much narrower:

- a stable plaintext event format for provider output
- a stable plaintext format for user prompts that agents consume

### 2. The outer `role: "session"` wrapper is not paying for itself

`role: "session"` plus inner `content.role` adds one more branch the app must support and one more migration surface the CLI must think about.

The wrapper made migration easier, but it is not a good steady-state design.

### 3. The current v2 proposal is still trying to be too much "a protocol"

The v2 draft improves readability, but it still feels over-designed:

- it still centers a large named "session protocol"
- it still tries to cover user, agent, subagent, permissions, files, and lifecycle in one umbrella concept
- it still assumes a new shared schema is the main abstraction boundary

That is likely the wrong center of gravity.

### 4. Permissions are still split across transcript and side channel

We already know this is a bad boundary:

- permission state lives in `agentState`
- tool lifecycle lives in message history
- the UI has to merge them back together

This is one of the biggest reasons the reducer is hard to maintain.

### 5. Provider normalization is too expensive in the app

The app should not have to understand five historical payload families forever.

The CLI/provider adapter should do the normalization work.

## Redesign goals

1. Keep transport unchanged.
2. Shrink the number of plaintext payload families to the minimum.
3. Stop treating this as a giant "session protocol" problem.
4. Move provider-specific weirdness fully into CLI adapters.
5. Make the app normalize one agent-event format, not many.
6. Put permissions into the event stream so the transcript is self-contained.
7. Keep the shape readable in raw JSON.
8. Make removal of legacy formats a planned outcome, not a permanent compatibility burden.
9. Keep refetch/update semantics centered on full canonical messages, not raw delta replay.

## Non-goals

- Replacing v3 HTTP messages
- Replacing Socket.IO invalidation right now
- Redesigning encrypted media transport
- Standardizing tool RPC or MCP
- Solving every future multi-agent workflow in v1

## Future directions to keep in mind

The current proposal in this document remains the plan of record for now.

The runtime tracing work in `docs/competition/opencode/runtime-tracing.md`
strengthened one thing and clarified another:

- OpenCode's **raw transcript shape** is still a strong reference
- for Happy's encrypted storage, we are choosing **patched canonical
  messages plus full-message sync updates**, not raw append-only patch replay

But there are two future directions we should keep explicitly on the table:

### 1. Adopt OpenCode's raw protocol shape instead of inventing our own final format

When we say "OpenCode" here, we mean **OpenCode's raw messaging protocol**, not the ACP wrapper path.

This is not the current plan, but it is a strong future direction to evaluate before we lock a new steady-state schema into `happy-wire`.

Why keep this in mind:

- adopting an existing agent transcript/event format is often better than inventing another bespoke one
- our current problems are mostly around envelope shape and normalization boundaries, not around transport
- the p6 worktree already proved that we want flatter, more direct records regardless of exact field naming

### 2. Roll back to Claude's old transcript shape if that turns out to be the simplest path

Claude's old JSONL/message format is still the most transcript-like provider-native shape we have worked with.

We may decide that the simplest practical move is not "new universal format", but rather:

- pick the Claude-style transcript as the base mental model
- normalize other providers toward that shape
- recover any useful historical context from older commits if needed

This likely requires digging up older commits and past adapter behavior before making a final call.

## Proposed split

Instead of one broad "session protocol", define only two steady-state plaintext payloads:

### 1. `user-message`

Used for prompts entering the agent pipeline.

```ts
type UserMessage = {
  kind: "user-message";
  id: string;
  time: number;
  text: string;
  attachments?: AttachmentRef[];
  meta?: {
    permissionMode?: string | null;
    model?: string | null;
    displayText?: string;
    sentFrom?: string;
  };
};
```

### 2. `agent-event`

Used for everything emitted by providers after adapter normalization.

```ts
type AgentEvent = {
  kind: "agent-event";
  id: string;
  time: number;
  type:
    | "turn-start"
    | "turn-end"
    | "message"
    | "thinking"
    | "tool-start"
    | "tool-end"
    | "permission-request"
    | "permission-response"
    | "attachment"
    | "service";
  turnId?: string;
  parentId?: string;
  agentId?: string;
  data: Record<string, unknown>;
};
```

That is the entire steady-state model.

Notably absent:

- no `role: "session"`
- no nested `ev`
- no separate `role` discriminator inside the agent event payload
- no provider-specific payloads in app storage

## Design rules

### Transport is dumb

The server continues to store and relay opaque encrypted blobs. This redesign does not change:

- DB rows
- `seq`
- `localId`
- v3 HTTP message APIs

The sync model should stay close to what we already do today for message
delivery:

- store canonical encrypted messages in ordinary session message rows
- when a message changes, patch the existing stored message
- emit a full updated message through the update path
- refetch should return the latest canonical message state directly

We are **not** choosing OpenCode-style raw `message.part.updated` /
`message.part.delta` replay as the primary durable sync model.

### User prompts stay simple

User prompts should remain easy to author and easy to inspect. They do not need turn IDs, subagent IDs, or event-style discriminators.

### Canonical agent messages are patchable

Agent output should be modeled as canonical transcript records, not as a raw
append-only patch log.

- Message IDs are stable
- In-place message patching is allowed when provider output is still streaming
  or settling
- Sync sends the full updated message, not low-level field deltas
- Refetch should yield the latest usable message state without replaying a raw
  patch stream
- Permissions are still transcript events
- Tool execution is still transcript-visible

This keeps the storage/sync mechanism aligned with the way Happy already thinks
about message delivery today, while still letting the inner decrypted payload
become much cleaner.

### Provider adapters own the mess

Claude, Codex, Gemini, OpenClaw, and ACP backends all have different native event shapes.

That is acceptable, but those shapes should stop at the CLI boundary.

The app should only ever see `agent-event`.

### Provider metadata belongs in session metadata, not every event

The app already knows session flavor/model configuration from session metadata.

We should not stamp provider identity onto every event unless it is explicitly needed for rendering or debugging.

If needed, use:

```ts
meta?: {
  providerRef?: string;
}
```

This should be rare and optional.

## Event model

### `turn-start`

```json
{
  "kind": "agent-event",
  "id": "msg_1",
  "time": 1710000000000,
  "type": "turn-start",
  "turnId": "turn_1",
  "data": {}
}
```

### `turn-end`

```json
{
  "kind": "agent-event",
  "id": "msg_2",
  "time": 1710000001000,
  "type": "turn-end",
  "turnId": "turn_1",
  "data": {
    "status": "completed"
  }
}
```

### `message`

Visible assistant output.

```json
{
  "kind": "agent-event",
  "id": "msg_3",
  "time": 1710000000100,
  "type": "message",
  "turnId": "turn_1",
  "data": {
    "text": "I found the bug."
  }
}
```

### `thinking`

Non-user-facing reasoning or internal progress text.

```json
{
  "kind": "agent-event",
  "id": "msg_4",
  "time": 1710000000150,
  "type": "thinking",
  "turnId": "turn_1",
  "data": {
    "text": "Comparing reducer state and incoming tool results"
  }
}
```

### `tool-start`

```json
{
  "kind": "agent-event",
  "id": "msg_5",
  "time": 1710000000200,
  "type": "tool-start",
  "turnId": "turn_1",
  "data": {
    "toolId": "tool_1",
    "toolName": "bash",
    "title": "Run `rg TODO`",
    "description": "Search for TODO markers in the repo",
    "input": {
      "command": "rg TODO"
    }
  }
}
```

### `tool-end`

```json
{
  "kind": "agent-event",
  "id": "msg_6",
  "time": 1710000000500,
  "type": "tool-end",
  "turnId": "turn_1",
  "data": {
    "toolId": "tool_1",
    "status": "completed"
  }
}
```

### `permission-request`

```json
{
  "kind": "agent-event",
  "id": "msg_7",
  "time": 1710000000300,
  "type": "permission-request",
  "turnId": "turn_1",
  "data": {
    "toolId": "tool_1",
    "toolName": "bash",
    "title": "Run `rm -rf node_modules`",
    "description": "Dangerous command requires approval",
    "options": [
      { "id": "allow-once", "label": "Allow once" },
      { "id": "allow-always", "label": "Allow for session" },
      { "id": "reject-once", "label": "Reject once" },
      { "id": "reject-always", "label": "Reject and remember" }
    ]
  }
}
```

### `permission-response`

```json
{
  "kind": "agent-event",
  "id": "msg_8",
  "time": 1710000000400,
  "type": "permission-response",
  "turnId": "turn_1",
  "data": {
    "toolId": "tool_1",
    "optionId": "allow-once"
  }
}
```

### `attachment`

```json
{
  "kind": "agent-event",
  "id": "msg_9",
  "time": 1710000000600,
  "type": "attachment",
  "turnId": "turn_1",
  "data": {
    "ref": "upload_1",
    "name": "screenshot.png",
    "mimeType": "image/png",
    "size": 153249,
    "image": {
      "width": 800,
      "height": 600,
      "thumbhash": "..."
    }
  }
}
```

### `service`

Only for internal but user-visible system text.

```json
{
  "kind": "agent-event",
  "id": "msg_10",
  "time": 1710000000700,
  "type": "service",
  "turnId": "turn_1",
  "data": {
    "text": "Reconnected to remote runtime"
  }
}
```

## Nesting and subagents

The current design spends too much energy on explicit subagent lifecycle.

For v1 of the redesign:

- keep `parentId`
- keep `agentId`
- drop dedicated subagent `start` / `stop` events

Why:

- the UI mostly cares about grouping child work under a parent tool
- `parentId` already gives us nesting
- `agentId` is enough to attribute repeated child output to the same worker
- explicit subagent lifecycle can be reintroduced later if we have a concrete UI need

Example:

```json
{
  "kind": "agent-event",
  "id": "msg_11",
  "time": 1710000000800,
  "type": "message",
  "turnId": "turn_1",
  "parentId": "tool_1",
  "agentId": "agent_1",
  "data": {
    "text": "Looking through src/auth"
  }
}
```

This is enough to render nested work without inventing more lifecycle than we currently use well.

## What moves out of `agentState`

`agentState` should remain control-plane state, not transcript recovery state.

Good candidates to keep in `agentState`:

- current mode
- available models / permission modes
- live session config
- transient backend capabilities

Bad candidates to keep in `agentState`:

- pending permission requests that must appear in transcript
- completed permission decisions that the user expects to review later

Those should become `permission-request` and `permission-response` events.

## App impact

The app normalizer should converge toward:

- parse `user-message`
- parse `agent-event`
- reject everything else once migration is complete

That lets us delete:

- provider-specific `codex` parsing
- provider-specific `acp` parsing
- most of the old `output` compatibility logic
- `role: "session"` compatibility handling

The reducer should also get simpler because:

- tool lifecycle comes from one event family
- permissions come from one event family
- sidechain grouping comes from `parentId` / `agentId`

## CLI impact

Every provider adapter becomes responsible for exactly one task:

> map provider-native output into `agent-event`

That means:

- Claude adapter stops thinking in terms of "session envelope"
- Codex adapter stops carrying protocol-specific special cases
- ACP runner emits the same final shape as Claude/Codex/OpenClaw
- Gemini finally joins the same format instead of keeping ACP-shaped payloads alive in storage

## Shared schema location

Do **not** rush this redesign into `happy-wire`.

`happy-wire` should hold stable contracts, not active design churn.

Recommended approach:

1. keep this redesign doc local to `docs/plans/`
2. implement one provider behind a feature flag
3. prove that app normalization and reducer complexity actually shrink
4. only then promote the schema into `happy-wire`

## Migration plan

### Phase 1: add new payloads alongside existing ones

- introduce `user-message` and `agent-event` schemas in CLI and app
- keep legacy parsing in app
- add a narrow compatibility path in storage/reducer
- add support for syncing a full updated message when an existing canonical
  message is patched

### Phase 2: migrate one provider end to end

Recommended first target:

- generic ACP runner or Codex

Reason:

- both already have adapter boundaries
- both already think in event streams

### Phase 3: move permissions into transcript

- emit `permission-request`
- emit `permission-response`
- keep `agentState` fallback temporarily
- switch UI to prefer transcript records over `agentState`

### Phase 4: migrate remaining providers

- Claude
- OpenClaw
- Gemini

### Phase 5: delete legacy parsing

After all providers emit the new shape and old sessions are no longer important:

- remove `codex` payload parsing
- remove `acp` payload parsing
- remove `output` payload parsing
- remove `role: "session"` wrapper parsing

## Open questions

1. Do we want user attachments embedded in `user-message`, or modeled as separate user records?
2. Should `tool-end` optionally carry summary/error output, or should tool output remain separate `message` events?
3. Do we need explicit `tool-progress` / `tool-output` later, or is `tool-start` + `message` + `tool-end` enough?
4. Should provider-native IDs ever be stored for debugging, or fully discarded after adapter mapping?
5. Do we need transcript-level read receipts, or is that a separate control-plane concern?

## Recommendation

Do not evolve the current session protocol further.

Treat `docs/plans/session-protocol-v2.md` as useful research, not the design we are committing to.

Treat the dirty `p6-message-envelope-v2` worktree as useful implementation research, not committed protocol history.

The better direction is:

- simple `user-message`
- simple `agent-event`
- patch existing canonical messages when they evolve
- send full updated messages through sync updates
- provider adapters do normalization
- app only renders one agent event family
- permissions become transcript events
- subagent handling uses `parentId` and `agentId`, without extra lifecycle until proven necessary

Keep these notes attached to that recommendation:

- for now, this document's proposal remains the active plan
- later, we should explicitly compare it against OpenCode's **raw** protocol shape
- we should also keep open the possibility of falling back to a Claude-style transcript model if that yields a simpler end-to-end system
- we are explicitly **not** choosing raw append-only patch-stream reconstruction
  as the main persistence/sync model
