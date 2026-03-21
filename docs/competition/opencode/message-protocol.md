# OpenCode Message Protocol

## Bottom line

OpenCode has the cleanest transcript shape of the three systems reviewed so far.
If Happy wants a strong protocol reference for app + server + session UI, this is
the one to steal from first.

## Core transcript model

The key design is: message envelope first, typed parts second.

- messages are stable top-level records with IDs, session linkage, model/provider metadata, path, token usage, cost, and error state
- content is not a single blob; it is an ordered list of typed parts
- important part kinds include `text`, `reasoning`, `tool`, `file`, `snapshot`, `patch`, `agent`, `subtask`, `step-start`, `step-finish`, and `compaction`
- this makes streaming, partial updates, replay, and debug rendering much cleaner than mutating one giant assistant string

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/session/message-v2.ts`
- `../happy-adjacent/research/opencode/packages/sdk/js/src/v2/gen/types.gen.ts`

## Live event model

OpenCode separates full transcript state from incremental transport events.

- canonical live events include `message.updated`, `message.part.updated`, `message.part.delta`, `message.part.removed`, `message.removed`, `session.status`, `todo.updated`, and `permission.asked`
- `message.part.delta` is the streaming primitive for appending text into a named field
- later `message.part.updated` events can replace or supersede earlier deltas
- the UI reducer explicitly merges stream events into cached transcript state

This is a very good pattern for Happy: use events for freshness, not as the only
source of truth.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/session/index.ts`
- `../happy-adjacent/research/opencode/packages/app/src/context/global-sync/event-reducer.ts`

## Subagents and task delegation

OpenCode models delegation as child sessions, not inline mystery behavior.

- the `task` tool chooses a non-primary agent and creates or resumes a child session
- `task_id` is really the child session ID, so delegation is resumable
- subagent intent is visible in the parent transcript as a tool call and related subtask part
- tool permissions for subagents are intentionally constrained

This is much closer to what Happy should want than flattening delegated work into
one chat thread without identity.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/tool/task.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/agent/agent.ts`

## Task tracking / todos

Todos are a first-class session store.

- todo state is separate from transcript parts
- write behavior is whole-list replacement with ordered rows
- schema is intentionally tiny: `content`, `status`, `priority`
- UI gets a proper todo dock instead of scraping plans from text

This is a strong design signal for Happy: todos should be their own state channel.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/tool/todo.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/session/todo.ts`

## Modes, models, and permissions

OpenCode treats these as explicit state, not just prompt flavor.

- newer logic keys on `agent`, `providerID`, `modelID`, and `variant`
- plan/build/general/explore are modeled as agent choices more than a free-form mode string
- permissions are first-class requests with `id`, `sessionID`, `permission`, patterns, metadata, and decision mode
- decisions can be `once`, `always`, or `reject`
- permission rules are pattern-based and support auto-unblocking pending matching requests

This is a good reference for Happy's app model even if Happy keeps its own policy
engine.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/permission/index.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/permission/evaluate.ts`
- `../happy-adjacent/research/opencode/packages/app/src/context/permission.tsx`

## Sandbox and isolation

OpenCode is weaker on true sandboxing than Codex.

- the main isolation story is workspace and git worktree separation
- extra workspaces are treated like sandboxes in product language
- the server routes operations by workspace directory
- there is not much evidence here of strong OS-level sandbox policy comparable to Codex

Takeaway for Happy: copy the workspace isolation ideas, not the lack of a deeper
sandbox layer.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/worktree/index.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/control-plane/workspace.ts`

## Sync and server architecture

This is probably the most valuable follow-up topic.

- the app listens to a global SSE stream
- events are then fanned into per-directory caches and reducers
- full session history is fetched separately when needed
- the client batches and coalesces updates instead of repainting on every raw event
- the control plane already looks ready for non-local workspace adaptors later

This is a much better direction for Happy than a single opaque message pipeline.

Primary source files:

- `../happy-adjacent/research/opencode/packages/opencode/src/control-plane/workspace-server/routes.ts`
- `../happy-adjacent/research/opencode/packages/opencode/src/control-plane/sse.ts`
- `../happy-adjacent/research/opencode/packages/app/src/context/global-sync.tsx`
- `../happy-adjacent/research/opencode/packages/app/src/context/sync.tsx`

## Context debug surface

The user feedback here is correct and important.

- clicking the context usage field opens a context tab
- that tab shows a useful breakdown of model/provider/context usage
- it also exposes raw message-plus-parts state, effectively a built-in protocol debugger

Happy should copy this idea.

Primary source files:

- `../happy-adjacent/research/opencode/packages/app/src/components/session-context-usage.tsx`
- `../happy-adjacent/research/opencode/packages/app/src/components/session/session-context-tab.tsx`

## What Happy should steal

- envelope + typed-parts transcript structure
- child-session subagent model with resumable IDs
- first-class todo and permission stores
- event stream for freshness plus fetch API for hydration
- built-in raw context/messages inspector in the UI
