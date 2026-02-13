# Session Protocol

This document defines the unified message protocol for Happy sessions. It replaces the existing mix of `output`, `codex`, and custom `acp` formats with a single, flat event stream. Old sessions continue using legacy formats; new sessions use this protocol exclusively.

For context on the existing wire protocol (WebSocket transport, encryption, sequencing), see `protocol.md`.

## Comparison with ACP

The real [Agent Communication Protocol](https://agentcommunicationprotocol.dev) is an agent-to-agent interoperability standard over REST. Our protocol solves a different problem: rendering encrypted agent chat sessions on mobile/web clients.

| Concern | ACP | This protocol |
|---|---|---|
| Purpose | Agent-to-agent interop (REST) | Encrypted chat with agent sessions |
| Transport | REST + SSE | Encrypted payloads over WebSocket |
| Message model | `Message { role, parts[] }` with MIME types | Flat event stream, discriminated by `t` |
| Content typing | MIME types (`text/plain`, `image/png`) | Explicit event types (`text`, `photo`, `file`) |
| Files | `content_url` or base64 with MIME type | Upload-first, referenced by `ref` |
| Images | Same as files (MIME-typed part) | First-class `photo` with thumbhash + dimensions |
| Tool calls | TrajectoryMetadata on parts | First-class `tool-call-start` / `tool-call-end` |
| Lifecycle | 7 run states, 11 SSE event types | `turn-start` / `turn-end` (2 events) |
| Event identity | UUID on runs, created_at on messages | `id` (cuid2) + `time` (ms) on every message |

**Why not ACP directly?**

1. **Encryption** — ACP assumes plaintext REST. Our payloads are end-to-end encrypted.
2. **Tool calls are UI-visible** — ACP models tools as metadata for debugging. We render them with spinners, descriptions, and permission dialogs.
3. **Instant image rendering** — ACP has no thumbhash or dimensions. Our `photo` event gives clients everything for instant placeholder layout.
4. **Simplicity** — 7 event types total. A client implements the full protocol in a single `switch`.

**What we take from ACP:**

- Role on the envelope (`user` / `agent`)
- Content by reference (`content_url` → `ref`)
- Separation of lifecycle events from content events

## Envelope

Every encrypted message payload:

```json
{
  "id": "<cuid2>",
  "time": 1739347200000,
  "role": "user" | "agent",
  "turn": "<turn id>",
  "invoke": "<call id>",
  "ev": { "t": "...", ... }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | cuid2 | Globally unique message identifier |
| `time` | number | Unix timestamp in milliseconds |
| `role` | `"user"` \| `"agent"` | Who produced this event |
| `turn` | string? | Turn id from `turn-start`. Required on all agent messages; agent messages without `turn` are ignored |
| `invoke` | string? | Optional. Tool call `call` id this message belongs to (subagent messages only) |
| `ev` | object | Event body, discriminated by `ev.t` |

## Subagents

When a tool call spawns a subagent (e.g. a Task tool), all messages produced by that subagent carry `invoke` set to the parent's `call` id. This keeps the stream flat while letting clients group subagent messages under their parent tool call.

Subagents can nest — a subagent's tool call can spawn another subagent. Each level references its immediate parent's `call` id via `invoke`.

## Events

### `text`

Text content displayed to the user. Supports markdown.

```json
{ "t": "text", "text": "Hello, how can I help?" }
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Message text (markdown) |
| `thinking` | boolean? | Optional. `true` if this is internal reasoning, not shown to user by default |

### `tool-call-start`

Agent begins a tool invocation.

```json
{
  "t": "tool-call-start",
  "call": "tc_abc",
  "name": "grep",
  "title": "Searching for handleClick",
  "description": "Searching for `handleClick` in **src/** directory",
  "args": { "pattern": "handleClick", "path": "src/" }
}
```

| Field | Type | Description |
|---|---|---|
| `call` | string | Tool call identifier, matched by `tool-call-end` |
| `name` | string | Tool name (lowercase, hyphenated) |
| `title` | string | Short summary (inline markdown: `` `code` ``, **bold**, *italic*, [links]) |
| `description` | string | Full description (inline markdown: `` `code` ``, **bold**, *italic*, [links]) |
| `args` | object | Tool input arguments |

### `tool-call-end`

Tool invocation completes. Matches a prior `tool-call-start` by `call`.

```json
{ "t": "tool-call-end", "call": "tc_abc" }
```

| Field | Type | Description |
|---|---|---|
| `call` | string | Matches `tool-call-start.call` |

### `file`

File attachment. The file must be uploaded to the server first.

```json
{ "t": "file", "ref": "upload_def", "name": "report.pdf" }
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload ID |
| `name` | string | Display filename |

### `photo`

Image attachment. The image must be uploaded to the server first.

```json
{
  "t": "photo",
  "ref": "upload_ghi",
  "thumbhash": "3OcRJYB4d3h/iIeHeEh3eIhw+j2w",
  "width": 1920,
  "height": 1080
}
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload ID |
| `thumbhash` | string | Base64-encoded [ThumbHash](https://evanw.github.io/thumbhash/) for instant placeholder |
| `width` | number | Original width in pixels |
| `height` | number | Original height in pixels |

### `turn-start`

Agent begins processing. Always `role: "agent"`. The message's `id` becomes the turn id — all subsequent agent messages reference it via `turn`.

```json
{ "t": "turn-start" }
```

### `turn-end`

Agent finishes processing. Always `role: "agent"`. Carries the same `turn` as the messages it closes.

```json
{ "t": "turn-end" }
```

## Example stream

```
← { id: "a1", time: 1000, role: "user",  ev: { t: "text", text: "Find TODOs" } }
← { id: "a2", time: 1001, role: "agent", ev: { t: "turn-start" } }
← { id: "a3", time: 1002, role: "agent", turn: "a2", ev: { t: "text", text: "Searching..." } }
← { id: "a4", time: 1003, role: "agent", turn: "a2", ev: { t: "tool-call-start", call: "tc1", name: "grep", title: "Searching for TODO", description: "Searching for `TODO` in project root", args: { pattern: "TODO" } } }
← { id: "a5", time: 1004, role: "agent", turn: "a2", ev: { t: "tool-call-end", call: "tc1" } }
← { id: "a6", time: 1005, role: "agent", turn: "a2", ev: { t: "text", text: "Found 3 TODOs." } }
← { id: "a7", time: 1006, role: "agent", turn: "a2", ev: { t: "turn-end" } }
```

The `turn-start` at `a2` establishes the turn. All subsequent agent messages carry `turn: "a2"`, including the `turn-end`.

Agent spawning a subagent:

```
← { id: "c1", time: 3000, role: "agent", turn: "a2", ev: { t: "tool-call-start", call: "tc2", name: "task", title: "Exploring codebase", description: "Searching for **auth** implementations", args: { prompt: "Find auth code" } } }
← { id: "c2", time: 3001, role: "agent", turn: "a2", invoke: "tc2", ev: { t: "text", text: "Looking at src/auth/..." } }
← { id: "c3", time: 3002, role: "agent", turn: "a2", invoke: "tc2", ev: { t: "tool-call-start", call: "tc3", name: "grep", title: "Searching for login", description: "Searching for `login` in **src/auth/**", args: { pattern: "login" } } }
← { id: "c4", time: 3003, role: "agent", turn: "a2", invoke: "tc2", ev: { t: "tool-call-end", call: "tc3" } }
← { id: "c5", time: 3004, role: "agent", turn: "a2", invoke: "tc2", ev: { t: "text", text: "Found auth handler." } }
← { id: "c6", time: 3005, role: "agent", turn: "a2", ev: { t: "tool-call-end", call: "tc2" } }
```

All messages carry `turn: "a2"` — they all belong to the same turn. Messages `c2`–`c5` also carry `invoke: "tc2"`, linking them to the subagent's parent tool call.

User sending a photo:

```
← { id: "b1", time: 2000, role: "user", ev: { t: "photo", ref: "up_1", thumbhash: "...", width: 800, height: 600 } }
← { id: "b2", time: 2001, role: "user", ev: { t: "text", text: "What's in this screenshot?" } }
```

## Design rules

1. **Flat stream** — no nesting; tool boundaries are markers in the stream
2. **Upload-first** — files and photos are uploaded to the server, then referenced by `ref`
3. **Every message has identity** — `id` (cuid2) + `time` (ms) on the envelope
4. **7 event types** — simple `switch(ev.t)` in any client
5. **Provider-agnostic** — no agent backend leaks into the protocol
6. **Consistent naming** — all `kebab-case`, no mixed conventions
7. **Inline markdown** — `title` and `description` support `` `code` ``, **bold**, *italic*, [links]
