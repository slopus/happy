# Codex: app-server integration

## How we run Codex

Codex is a **system-wide CLI** (`npm install -g @openai/codex`). We don't bundle it.

At startup, `CodexAppServerClient` spawns `codex app-server --listen stdio://` as a child process and talks JSON-RPC 2.0 over stdin/stdout (newline-delimited JSON). The Codex process manages its own model inference, sandbox, and tool execution. We just send prompts and react to events.

Version check: `codex --version` must report >= 0.100 for app-server support.

## Why app-server (not MCP)

The old `codex mcp-server` integration had three unfixable problems:

1. **Model change = context loss.** `codex-reply` only accepts `{ prompt, threadId }`. No model param. Changing model meant restarting the session.
2. **Permission cancel hangs forever.** MCP SDK's `callTool` waits for a response that never comes after `turn_aborted`. Our AbortController workaround was brittle.
3. **Session ID confusion.** Three different ID fields (`sessionId`, `conversationId`, `threadId`) — only `threadId` worked, and it was undocumented.

`codex app-server` solves all three: per-turn model/policy overrides, clean `turn/interrupt` RPC, single `threadId`.

## Architecture

```
Mobile App → Happy Server → CLI (runCodex.ts) → CodexAppServerClient → codex app-server (child process)
                                                    ↕ JSON-RPC 2.0 over stdio
                                                  Events ← codex/event/* notifications
                                                  Approvals ← item/commandExecution/requestApproval (server→client RPC)
```

The client has three responsibilities:
- **Lifecycle**: `initialize` handshake → `thread/start` → `turn/start` per message → `turn/interrupt` on abort
- **Events**: Route `codex/event/*` notifications to the event handler (same EventMsg types as old MCP)
- **Approvals**: Respond to server→client RPC requests for command/patch approval

## Key protocol findings (learned the hard way)

These aren't in any docs. Discovered by trial and error:

| What | Expected | Actual |
|------|----------|--------|
| Thread ID location | `result.conversationId` | `result.thread.id` |
| Turn params | `conversationId`, `items` | `threadId`, `input` |
| Input item format | `{ type: "text", data: { text } }` | `{ type: "text", text }` (flat) |
| Sandbox policy | `"read-only"`, `"workspace-write"` | `{ type: "readOnly" }`, `{ type: "workspaceWrite" }` (camelCase objects) |
| Approval method | `execCommandApproval` | `item/commandExecution/requestApproval` |
| Approval decisions | `approved`, `denied`, `abort` | `accept`, `decline`, `cancel` (wire format differs from internal) |
| Event routing | `codex/event` with type in params | `codex/event/<type>` (type in method name) |
| Empty model string | Ignored | Error: "model '' not supported" (must omit, not send empty) |

## Design decisions

### Per-turn overrides (no restart needed)
Each `turn/start` RPC accepts optional `model`, `approvalPolicy`, `sandboxPolicy`. The thread keeps context across policy changes. This eliminated the mode-change restart block and `experimental_resume` dead code.

### Turn completion tracking
`sendTurnAndWait()` creates a Promise resolved when `task_complete` or `turn_aborted` arrives. Safety nets: 10-minute timeout, process exit handler, disconnect handler. This replaced the AbortController hack.

### Duplicate tool call fix
The old mapper generated `tool-call-start` for both `exec_approval_request` AND `exec_command_begin`. Since the permission handler already renders approval UI via agent state, this created duplicate cards. Fix: only `exec_command_begin` generates `tool-call-start`.

### Approval translation layer
Our internal types use `approved`/`denied`/`abort`. The wire protocol uses `accept`/`decline`/`cancel`. `mapDecisionToWire()` translates between them so the rest of the codebase doesn't need to know about wire format.

## Files

- `codexAppServerClient.ts` — JSON-RPC client, turn tracking, approval handling
- `codexAppServerTypes.ts` — Cherry-picked types from the protocol
- `runCodex.ts` — Main loop, event/approval handler wiring
- `executionPolicy.ts` — Maps permission modes to approval/sandbox policies
- `sessionProtocolMapper.ts` — Events → session protocol envelopes (shared with old code)

## What we don't handle yet

The app-server sends ~60 event types we ignore. Notable ones for future:
- `collab_*` — multi-agent collaboration events
- `web_search_*` — web search tool results
- `planning_*` — planning mode events
- `streaming_content_delta` — finer-grained streaming
- `mcp_*` — MCP server lifecycle (we do use `mcp_startup_complete`)

## References

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [experimental_resume broken — issue #4393](https://github.com/openai/codex/issues/4393)
