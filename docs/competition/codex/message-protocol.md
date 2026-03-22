# Codex App-Server Protocol

## Bottom line

Codex has the strongest server protocol of the systems reviewed so far.
It is especially useful for approvals, runtime state, resume/fork, and sandbox
policy.

## Core transport and state model

Codex app-server speaks JSON-RPC 2.0 over stdio and an experimental websocket
transport.

- the core persistent model is `thread` -> `turn` -> `item`
- clients start, resume, or fork threads explicitly
- turns are started explicitly and stream item updates live
- `ThreadItem` is a tagged union, not an untyped blob

Primary source files:

- `../happy-adjacent/research/codex/codex-rs/app-server/README.md`
- `../happy-adjacent/research/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

## Transcript and live notifications

Codex leans heavily on typed notifications.

- notifications cover thread lifecycle, turn lifecycle, plan updates, deltas, approvals, and more
- important item families include `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, and `contextCompaction`
- live streaming is done with dedicated delta notifications rather than a single text stream
- the README explicitly warns that initial thread or turn payloads may be sparse; live notifications are the canonical source of active state

This is a good reminder for Happy: a list endpoint and a stream endpoint should not be the same thing.

## Subagents and collaboration

Codex models subagents as typed items, not hidden side effects.

- collaboration agent activity appears as `CollabAgentToolCall`
- supported actions include spawn, send input, resume, wait, and close
- thread metadata can indicate subagent origin and carry agent nickname/role
- thread status and collab-agent state are explicit typed fields

This is a good template for representing delegated work inside Happy without losing identity.

Primary source files:

- `../happy-adjacent/research/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

## Approval model

Codex's approval model is one of the best things in the repo.

- approvals are not just notifications; the server sends explicit JSON-RPC requests to the client
- there are separate approval request shapes for command execution, file changes, permission changes, user input, and MCP elicitation
- the server later emits resolution notifications so UI state can clear correctly
- reviewer identity can be the user or a guardian subagent

Happy should copy this structure: normal event stream for state, explicit server requests for blocking decisions.

Primary source files:

- `../happy-adjacent/research/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `../happy-adjacent/research/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

## Modes and model switching

Codex exposes this as structured protocol state.

- model/provider/service tier/effort/summary/personality can be set at thread or turn boundaries
- collaboration mode is a real protocol concept with its own list and selection surface
- model reroutes are surfaced as protocol events with reason fields

This is much better than hiding mode changes in prompt text or UI-only state.

## Sandbox policy

Codex clearly wins on sandbox expressiveness.

- coarse modes include read-only, workspace-write, and full access
- richer `SandboxPolicy` variants allow writable roots, read-only access, network access, and external sandbox options
- there are Windows-specific setup flows for sandbox support
- some commands are explicitly unsandboxed, which is documented rather than hidden

This is a strong reference for Happy's server-side permission and sandbox contract.

## Resume, fork, and lifecycle

Resume and fork are treated as first-class protocol paths.

- `thread/resume` supports several restore paths
- `thread/fork` supports persistent and ephemeral forks
- protocol has knobs such as `persist_extended_history`
- runtime live-watch state is separated from persisted thread history
- tests cover real edge cases like joining a running thread or replaying pending approvals on resume

This split between stored history and live watcher state is worth copying.

## Sync and transport robustness

Codex is more serious than the others about backpressure and client capability drift.

- websocket support has explicit health endpoints and origin restrictions
- bounded queues protect the server
- overloaded request paths return errors instead of hanging forever
- slow websocket clients can be disconnected cleanly
- notification filtering and experimental field gating exist per connection

Happy should take this seriously if it wants robust mobile or multi-client session control.

Primary source files:

- `../happy-adjacent/research/codex/codex-rs/app-server/src/lib.rs`
- `../happy-adjacent/research/codex/codex-rs/app-server/src/transport.rs`
- `../happy-adjacent/research/codex/codex-rs/app-server/src/thread_state.rs`

## What Happy should steal

- explicit `thread` / `turn` / `item` protocol model
- server-initiated approval requests
- typed collab-agent items for subagents
- real sandbox policy objects with network and path controls
- clear split between persisted history and runtime watcher state
