# Session Protocol Unification v2 — Draft

Status: **DRAFT**

## Overview

This document captures the proposed unified session protocol event types, incorporating feedback on top of the original `session-protocol-unification.md` plan. The goal is the same — all agents emit a single envelope format, all legacy senders die — but the event type surface has been redesigned.

For the migration mechanics (phases, task lists, app-side cleanup), see the original plan (stashed as `session-protocol-unification.md`).

## Envelope (unchanged)

```json
{
  "id": "<cuid2>",
  "time": 1739347200000,
  "role": "user" | "agent",
  "turn": "<cuid2>",
  "subagent": "<cuid2>",
  "ev": { "t": "...", ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | cuid2 | Globally unique message identifier |
| `time` | number | Unix timestamp in milliseconds |
| `role` | `"user"` \| `"agent"` | Who produced this event |
| `turn` | cuid2? | Turn id established by `turn-start`. Required on all agent messages during a turn |
| `subagent` | cuid2? | Subagent identifier — matches `agentId` from `subagent-start` |
| `ev` | object | Event body, discriminated by `ev.t` |

## Event Types (14)

### Content

**`text`** — user or agent

```json
{ "t": "text", "text": "Hello, how can I help?", "thinking": true }
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Message text (markdown) |
| `thinking` | boolean? | Agent only. `true` for internal reasoning |
| `steer` | boolean? | User only. Mid-turn injection — picked up between LLM calls. Default user messages queue for next turn |

Client-side ordering note: steer messages are displayed immediately but the agent hasn't picked them up yet. The app pins them below current agent output until `turn-end` or until the agent emits output that follows the steer. No protocol-level ordering needed — client display logic handles this.

**`file`** — user or agent

```json
{ "t": "file", "ref": "upload_def", "name": "report.pdf", "size": 524288, "image": { "width": 800, "height": 600, "thumbhash": "..." } }
```

| Field | Type | Description |
|-------|------|-------------|
| `ref` | string | Server upload ID |
| `name` | string | Display filename |
| `size` | number | File size in bytes |
| `image` | object? | Optional image metadata |
| `image.width` | number | Image width in pixels |
| `image.height` | number | Image height in pixels |
| `image.thumbhash` | string | Base64-encoded ThumbHash for instant placeholder |

### Turn Lifecycle

**`turn-start`** — agent

```json
{ "t": "turn-start" }
```

Establishes the `turn` id on the envelope. Also serves as the "agent picked up your message" signal — the gap between user `text` (sent) and `turn-start` is the "queued" window.

**`turn-end`** — agent

```json
{ "t": "turn-end", "status": "completed", "usage": { "inputTokens": 2400, "outputTokens": 180, "cost": 0.012 } }
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"completed"` \| `"failed"` \| `"cancelled"` | Final turn outcome |
| `usage` | object? | Token usage for this turn |
| `usage.inputTokens` | number | Input tokens consumed |
| `usage.outputTokens` | number | Output tokens generated |
| `usage.cost` | number | Cost in USD |

Replaces the ephemeral `usage-report` socket event. Also replaces the legacy `ready` signal — `turn-end` IS the ready signal.

### Tool Calls

**`tool-call-start`** — agent

```json
{ "t": "tool-call-start", "call": "tc_abc", "name": "grep", "title": "Searching for handleClick", "description": "Searching for `handleClick` in **src/**", "args": { "pattern": "handleClick" } }
```

| Field | Type | Description |
|-------|------|-------------|
| `call` | string | Tool call identifier, matched by `tool-call-end` |
| `name` | string | Tool name (lowercase, hyphenated) |
| `title` | string | Short summary (inline markdown) |
| `description` | string | Full description (inline markdown) |
| `args` | object | Tool input arguments |

**`tool-call-end`** — agent

```json
{ "t": "tool-call-end", "call": "tc_abc" }
```

### Service

**`service`** — agent

```json
{ "t": "service", "text": "Context window compacted" }
```

System/internal messages — reconnecting, context compacted, process errors. Not from the LLM.

### Subagent

**`subagent-start`** — agent

```json
{ "t": "subagent-start", "agentId": "sa_abc123", "title": "Research agent" }
```

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | Subagent identifier — same value used in envelope `subagent` field on all messages this subagent produces |
| `title` | string? | Human-readable label |

**`subagent-stop`** — agent

```json
{ "t": "subagent-stop", "agentId": "sa_abc123" }
```

### Session Control

**`session-control-changed`** — user or agent

```json
{ "t": "session-control-changed", "clientType": "phone", "tokenId": "tok_abc123" }
```

| Field | Type | Description |
|-------|------|-------------|
| `clientType` | `"cli"` \| `"phone"` \| `"browser"` \| `"daemon"` | What took control |
| `tokenId` | string? | Auth token identifying the device/session. Used for push notification routing — don't send to phone if browser has control |

Controlling device is also written to session state (metadata) as a rollup of the stream.

### Permissions

**`permission-request`** — agent

```json
{
  "t": "permission-request",
  "call": "tc_abc",
  "toolName": "bash",
  "title": "Run `rm -rf node_modules`",
  "description": "Delete node_modules directory",
  "args": { "command": "rm -rf node_modules" }
}
```

Always during a turn. Appears between `tool-call-start` and `tool-call-end`. The tool does not execute until the user responds. RPC still delivers in real-time, but the message is the permanent record in the stream.

**`permission-response`** — user

```json
{ "t": "permission-response", "call": "tc_abc", "decision": "allow-once" }
```

Matches the `call` from the request.

### Abort

**`abort`** — user

```json
{ "t": "abort" }
```

Written to the stream when user presses stop. RPC still does real-time delivery. Agent responds with `turn-end { status: "cancelled" }`.

### Configuration

**`agent-configuration-changed`** — user or agent

```json
{ "t": "agent-configuration-changed", "model": "claude-sonnet-4-6", "thinkingLevel": "high" }
```

All fields optional — include only what changed:

| Field | Type | Description |
|-------|------|-------------|
| `permissionMode` | string? | `"default"` \| `"acceptEdits"` \| `"bypassPermissions"` \| `"plan"` |
| `model` | string? | Model identifier |
| `thinkingLevel` | string? | Thinking budget level |
| `sandbox` | boolean? | Sandbox enabled |

User sends this when changing config from the app. Agent sends this when entering plan mode, etc. The actual config mechanism stays in session metadata (optimistic concurrency) — this event is the audit trail in the stream so you can scroll back and see "model was switched to Sonnet here."

## Event Type Summary

| Category | `ev.t` | Role | New? |
|----------|--------|------|------|
| Content | `text` | user/agent | modified (added `steer`) |
| Content | `file` | user/agent | existing |
| Turn | `turn-start` | agent | existing |
| Turn | `turn-end` | agent | modified (added `usage`) |
| Tool calls | `tool-call-start` | agent | existing |
| Tool calls | `tool-call-end` | agent | existing |
| Service | `service` | agent | existing |
| Subagent | `subagent-start` | agent | renamed, added `agentId` |
| Subagent | `subagent-stop` | agent | renamed, added `agentId` |
| Session | `session-control-changed` | user/agent | new |
| Permissions | `permission-request` | agent | new |
| Permissions | `permission-response` | user | new |
| Abort | `abort` | user | new |
| Config | `agent-configuration-changed` | user/agent | new |

## Removed

| What | Why |
|------|-----|
| `ready` signal (`sendSessionEvent({ type: 'ready' })`) | Redundant with `turn-end` |
| `start` / `stop` event names | Renamed to `subagent-start` / `subagent-stop` |
| `machineId` on control-changed | Replaced by `tokenId` — auth token already identifies the device |
| Ephemeral `usage-report` socket event | Moved into `turn-end.usage` |

## Realistic Flow

User opens session on phone, agent runs on CLI, user steers mid-turn, switches model, aborts.

```
// CLI starts, takes control
← { id: "m1",  time: 1000, role: "agent",  ev: { t: "session-control-changed", clientType: "cli", tokenId: "tok_laptop" } }

// User sends prompt from phone
← { id: "m2",  time: 2000, role: "user",   ev: { t: "text", text: "Find all TODO comments and fix the critical ones" } }

// Agent picks it up
← { id: "m3",  time: 2500, role: "agent",  turn: "t1", ev: { t: "turn-start" } }
← { id: "m4",  time: 2501, role: "agent",  turn: "t1", ev: { t: "text", text: "I'll search for TODOs first." } }
← { id: "m5",  time: 2502, role: "agent",  turn: "t1", ev: { t: "tool-call-start", call: "c1", name: "grep", title: "Searching for TODO", description: "Searching for `TODO` in **src/**", args: { "pattern": "TODO", "path": "src/" } } }
← { id: "m6",  time: 2503, role: "agent",  turn: "t1", ev: { t: "tool-call-end", call: "c1" } }
← { id: "m7",  time: 2504, role: "agent",  turn: "t1", ev: { t: "text", text: "Found 12 TODOs. Starting with the auth module..." } }

// User steers mid-turn — agent hasn't seen this yet
← { id: "m8",  time: 2600, role: "user",   ev: { t: "text", text: "Skip auth, focus on the payment module instead", steer: true } }

// Agent continues current LLM call, then picks up steer
← { id: "m9",  time: 2700, role: "agent",  turn: "t1", ev: { t: "tool-call-start", call: "c2", name: "edit", title: "Editing **src/payment/checkout.ts**", description: "Fixing TODO in payment module", args: { "file": "src/payment/checkout.ts" } } }

// Agent needs permission for a destructive edit
← { id: "m10", time: 2701, role: "agent",  turn: "t1", ev: { t: "permission-request", call: "c2", toolName: "edit", title: "Editing **src/payment/checkout.ts**", description: "Replacing TODO with retry logic", args: { "file": "src/payment/checkout.ts" } } }

// User approves
← { id: "m11", time: 3000, role: "user",   ev: { t: "permission-response", call: "c2", decision: "allow-once" } }

// Tool executes
← { id: "m12", time: 3001, role: "agent",  turn: "t1", ev: { t: "tool-call-end", call: "c2" } }

// Agent spawns a subagent to research the second TODO
← { id: "m13", time: 3002, role: "agent",  turn: "t1", ev: { t: "subagent-start", agentId: "sa_research", title: "Payment research" } }
← { id: "m14", time: 3003, role: "agent",  turn: "t1", subagent: "sa_research", ev: { t: "text", text: "Looking at payment retry patterns..." } }
← { id: "m15", time: 3004, role: "agent",  turn: "t1", subagent: "sa_research", ev: { t: "tool-call-start", call: "c3", name: "grep", title: "Searching for retry", description: "Searching for retry patterns", args: { "pattern": "retry" } } }
← { id: "m16", time: 3005, role: "agent",  turn: "t1", subagent: "sa_research", ev: { t: "tool-call-end", call: "c3" } }
← { id: "m17", time: 3006, role: "agent",  turn: "t1", subagent: "sa_research", ev: { t: "text", text: "Found existing retry utility." } }
← { id: "m18", time: 3007, role: "agent",  turn: "t1", ev: { t: "subagent-stop", agentId: "sa_research" } }

// Turn completes with usage
← { id: "m19", time: 3008, role: "agent",  turn: "t1", ev: { t: "text", text: "Fixed 2 TODOs in the payment module." } }
← { id: "m20", time: 3009, role: "agent",  turn: "t1", ev: { t: "turn-end", status: "completed", usage: { inputTokens: 4800, outputTokens: 620, cost: 0.024 } } }

// User switches model from phone
← { id: "m21", time: 5000, role: "user",   ev: { t: "agent-configuration-changed", model: "claude-sonnet-4-6", thinkingLevel: "low" } }

// User sends next prompt
← { id: "m22", time: 5001, role: "user",   ev: { t: "text", text: "Now run the tests" } }
← { id: "m23", time: 5100, role: "agent",  turn: "t2", ev: { t: "turn-start" } }
← { id: "m24", time: 5101, role: "agent",  turn: "t2", ev: { t: "tool-call-start", call: "c4", name: "bash", title: "Run `npm test`", description: "Running test suite", args: { "command": "npm test" } } }

// User aborts
← { id: "m25", time: 5200, role: "user",   ev: { t: "abort" } }
← { id: "m26", time: 5201, role: "agent",  turn: "t2", ev: { t: "tool-call-end", call: "c4" } }
← { id: "m27", time: 5202, role: "agent",  turn: "t2", ev: { t: "turn-end", status: "cancelled" } }

// User opens session from browser — control shifts, push notifications reroute
← { id: "m28", time: 8000, role: "user",   ev: { t: "session-control-changed", clientType: "browser", tokenId: "tok_browser" } }
```

## What Stays on Side Channels

| Thing | Mechanism | Why not in stream |
|-------|-----------|-------------------|
| Activity/presence | Ephemeral `session-alive` / `session-end` socket events | Too frequent, not worth persisting |
| Config source of truth | Session metadata with optimistic concurrency | `agent-configuration-changed` is the audit trail, metadata is the mechanism |
| Permission delivery | RPC for real-time, stream for audit | RPC needed for immediate response, stream needed for history |
| Abort delivery | RPC for real-time, stream for audit | Same pattern |

## Migration — What Needs to Change

### CLI legacy senders to remove

| Method | Current wire shape | Used by | Action |
|--------|--------------------|---------|--------|
| `sendAgentMessage(provider, body)` | `{ role: 'agent', content: { type: 'acp', provider, data } }` | `runGemini.ts` (~25 call sites) | Replace with `AcpSessionManager` → `sendSessionProtocolMessage()` |
| `sendCodexMessage(body)` | `{ role: 'agent', content: { type: 'codex', data } }` | Dead code — Codex already on envelopes | Delete |
| `sendSessionEvent(event)` | `{ role: 'agent', content: { type: 'event', data } }` | All runners: ready, errors, mode switch | Delete — `turn-end` replaces ready, `service` replaces error messages |
| `ACPMessageData` type | — | `apiSession.ts` | Delete with `sendAgentMessage()` |
| `ACPProvider` type | — | `apiSession.ts` | Delete with `sendAgentMessage()` |
| `MessageAdapter` class | — | `agent/adapters/MessageAdapter.ts` | Delete — unused once `sendAgentMessage()` is gone |

### CLI: Gemini migration

`runGemini.ts` is the only runner still on `sendAgentMessage()`. Wire in `AcpSessionManager` (already works for the generic ACP runner and OpenClaw) and route all message dispatch through it.

### CLI: user text format

The CLI already emits only the modern `role: 'session'` envelope for user text. The `ENABLE_SESSION_PROTOCOL_SEND` flag that was planned as a rollout toggle was never implemented in code — removed from docs.

### App legacy branches to remove (in `typesRaw.ts` rawAgentRecordSchema)

| Branch | `content.type` | Action |
|--------|----------------|--------|
| `acp` | `{ type: 'acp', provider, data }` | Remove after Gemini migration |
| `codex` | `{ type: 'codex', data }` | Remove — Codex already on envelopes |
| `event` | `{ type: 'event', data }` | Remove — replaced by `service` and `turn-end` |
| `output` | Raw Claude JSONL | Keep for historical message replay (oldest format, may exist in production databases) |

Also remove the hyphenated content normalization transforms (`normalizeToToolUse()` / `normalizeToToolResult()`) once no active clients send those formats.

### happy-wire schema updates

- Rename `start`/`stop` → `subagent-start`/`subagent-stop` with `agentId` field
- Add `usage` to `turn-end` schema
- Add new event types: `session-control-changed`, `agent-configuration-changed`, `permission-request`, `permission-response`, `abort`
- Add `steer` field to `text` event schema

## Open Questions

- **`steer` field naming**: `steer: true` vs `sendType: "steer"` vs `queuing: "immediate"` — bikeshed later
- **Permission auto-approval**: when a tool is auto-approved (from a previous `allow-always`), emit `permission-request` + `permission-response` to the stream for audit, or skip for noise reduction?
- **Subagent `agentId` format**: cuid2 like today, or human-readable like `sa_research`? Examples above use readable ids for clarity but production would be cuid2
- **`session-control-changed` and metadata rollup**: exact fields to mirror in session state TBD
