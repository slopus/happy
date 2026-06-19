# Claude Goal Parity Design

## Goal

Give Claude sessions the same Happy goal-bar UX that Codex sessions have today: show the current goal, let the user clear it, and let the user edit it from the UI.

The implementation must preserve the existing ownership boundary: Claude owns the goal lifecycle. Happy only observes Claude-owned state and routes Claude-native commands.

## Product Principle

Codex exposes goal state and actions through app-server protocol methods such as `thread/goal/set`, `thread/goal/clear`, and goal update notifications. Claude does not currently expose an equivalent typed SDK goal API.

Claude does expose two useful surfaces:

- `/goal <condition>` and `/goal clear` as Claude-native slash commands.
- `goal_status` transcript attachments written by Claude Code when a goal is set or evaluated.

Happy can use these together for UX parity, but not protocol parity. The UI may look the same as Codex, while the Claude adapter remains a command-delegating observer:

- Button clicks send Claude slash commands.
- The visible goal state changes only after a Claude-owned `goal_status` attachment confirms the new state.
- Happy never treats user text, command echoes, local-command stdout, or assistant prose as current goal state.

Parity means the user sees the same goal bar and the same clear/edit affordances when Claude can confirm them. It does not mean the Claude adapter may pretend to have Codex-style synchronous goal RPCs.

## Scope

In scope:

- Recognize Claude JSONL `type: "attachment"` entries whose nested `attachment.type` is `"goal_status"`.
- Map valid Claude `goal_status` payloads into the existing encrypted `AgentState.agentGoalStatus` contract.
- Expose `clear` and `edit` capabilities for Claude active goals only when the running Claude session supports `/goal` and the adapter can observe `goal_status`.
- Route the existing `goal-action` session RPC for Claude:
  - `clear` sends `/goal clear`
  - `edit` sends `/goal <new condition>`
- Keep the existing `AgentGoalBar` UX and action handling shared between Claude and Codex.
- Keep `/goal ...` chat-chip behavior as a historical "sent as goal" affordance only.

Out of scope:

- A Happy-owned goal store or goal evaluator.
- Inferring goal state from transcript prose, command wrapper text, statusline text, or hook stdout.
- A Claude `stop` goal button. In Claude, stop-style aliases are clear aliases, while Happy's UI would make "stop" look like execution interrupt.
- A goal progress popover from `iterations`, `durationMs`, `tokens`, or evaluator `reason`. Those fields may be logged or reserved for future debug surfaces, but they are not the current compact bar.
- A fallback that hides the bar optimistically after sending `/goal clear`.

## Discovery Gate

Implementation must start by capturing real Claude fixtures for the current supported Claude Code paths before enabling action capabilities:

- active goal set through `/goal <condition>`
- goal replaced through `/goal <new condition>` while another goal is active
- goal cleared through `/goal clear`
- local interactive mode if Happy intends to expose action buttons while the session is currently local
- remote-controlled mode through the SDK path

Each fixture must include the raw JSONL records needed to prove the state transition. If a path does not emit a structured `goal_status` confirmation, that path may still support read-only goal tracking, but it must not report the unconfirmable action capability.

## Claude Source Signal

The accepted Claude source is a JSONL entry with this conceptual shape:

```json
{
  "type": "attachment",
  "uuid": "...",
  "timestamp": "...",
  "sessionId": "...",
  "version": "2.1.179",
  "attachment": {
    "type": "goal_status",
    "met": false,
    "sentinel": true,
    "condition": "..."
  }
}
```

Completion payloads may include:

```json
{
  "attachment": {
    "type": "goal_status",
    "met": true,
    "condition": "...",
    "reason": "...",
    "iterations": 1,
    "durationMs": 55752,
    "tokens": 3078
  }
}
```

Mapping rules:

- `met: false` with a non-empty `condition` maps to `status: "active"`.
- `met: true` maps to `status: "inactive", reason: "completed"` when the payload includes a completed evaluation.
- A clear confirmation maps to `status: "inactive", reason: "cleared"` only after implementation captures and tests the concrete Claude payload emitted by `/goal clear`.
- Malformed or incomplete `goal_status` payloads map to `status: "unavailable", reason: "malformed"` or are ignored if keeping the previous state would be fresher and safer.

For refresh from an existing transcript, the adapter must reduce all `goal_status` attachments for the current Claude session in file order and use only the latest resulting state. It must not resurrect the first active sentinel if a later completed or cleared payload exists.

Required identity fields:

- `source: "claude"`
- `sourceSessionId: raw.sessionId` for active states
- `sourceRevision: raw.uuid` when available, otherwise raw timestamp
- `observedAt: Date.now()`

The app already checks active goals against the current `metadata.claudeSessionId`. The Claude adapter must keep that invariant.

## Capability Rules

Claude active goals expose capabilities only when all gates are true:

- The current SDK metadata reports the goal slash command (`goal` or `/goal`), or the adapter otherwise has a confirmed Claude Code version that supports `/goal`.
- The adapter has observed a valid `goal_status` source for the current Claude session.
- The specific action has a fixture-backed confirmation path for the current runtime path.

When all gates pass, Claude may report:

```ts
capabilities: { clear: true, edit: true }
```

Do not report `stop`.

If `/goal clear` or `/goal <new condition>` does not produce a structured confirmation in a tested Claude version, the adapter must fail closed by withholding that capability for that version/path. The UI must not offer a button whose resulting state cannot be confirmed from Claude-owned data.

Capabilities can be partial. For example, if replacement emits a new active `goal_status` but clear does not emit an inactive confirmation, report `edit: true` and omit `clear`.

## Action Flow

Clear:

1. User taps the existing goal-bar clear action.
2. App calls the existing `sessionGoalAction(sessionId, "clear")` RPC.
3. Claude adapter validates the current active goal is Claude-owned and action-capable.
4. Adapter enqueues `/goal clear` as an isolated Claude command that cannot batch with neighboring user prompts.
5. UI marks only the clear action as in flight.
6. Adapter waits for a bounded clear confirmation from Claude's next structured goal-state signal.
7. UI updates only from the resulting `agentGoalStatus`.

Edit:

1. User taps edit.
2. App opens the existing goal edit prompt with the current text.
3. App calls `sessionGoalAction(sessionId, "edit", objective)`.
4. Claude adapter validates a non-empty objective and enqueues `/goal <objective>` as an isolated Claude command that cannot batch with neighboring user prompts.
5. Claude replaces the active session goal according to `/goal` command semantics.
6. The action completes when a new active `goal_status` for the same source session and matching objective arrives. It must not wait for the goal to be achieved.

Timeout and failure behavior:

- If command routing fails, return an RPC error and keep the previous authoritative state.
- If no confirming `goal_status` arrives within a short timeout, return an RPC error, clear the action spinner, and keep the previous authoritative state. Mark the source `unavailable` only if the adapter can prove the current Claude session changed or stopped.
- Never hide or rewrite the bar solely because the UI action was sent.
- The command must not discard unrelated pending user prompts. Do not use a queue operation that clears pending prompts unless the queue is known to be empty. If the existing queue cannot isolate without clearing, add a small isolated-command path instead of reusing a destructive queue operation.

## Architecture

Add a narrow Claude goal mapper, separate from the chat protocol mapper:

- `claudeGoalStatus.ts`
  - validates Claude `goal_status` attachments
  - maps them to `AgentGoalStatus`
  - exposes capability helper(s)
  - includes focused tests for active, completed, malformed, wrong-session, and action-capability cases

Extend the Claude JSONL schema and scanner plumbing:

- Keep `RawJSONLinesSchema` conversation-only for the values passed to `sendClaudeSessionMessage` and `sessionProtocolMapper`.
- Add a separate scanner-side parser for recognized non-chat transcript events. The parser must inspect raw JSONL before the conversation-message schema drops unknown types.
- Keep normal conversation attachment entries out of `sendClaudeSessionMessage`.
- Add a callback or side channel from `createSessionScanner` for recognized non-chat attachments, so `goal_status` can update agent state without becoming a chat message or expanding the chat mapper input union.
- Process `goal_status` attachments even in remote mode, where the current chat scanner intentionally forwards only terminal-typed `type: "user"` records.
- Preserve existing behavior for other attachment types such as skill listings, file memories, task reminders, and edited file snippets.

Wire Claude runtime:

- Store whether the current session supports `/goal` from SDK `system.init` slash-command metadata when available.
- On every valid `goal_status` from the active Claude session, update agent state with a functional merge such as `updateAgentState((current) => ({ ...current, agentGoalStatus }))`.
- Dedupe repeated observations by attachment `uuid` or another stable source revision before updating state.
- Register `goal-action` for Claude with the same RPC method name the app already uses for Codex.
- Route actions through the Claude input queue using the current enhanced mode defaults, but as isolated commands that preserve unrelated pending prompts.
- If the session is currently local, do not inject text into the user's terminal. Use the same app-message handoff semantics as ordinary Happy app messages: switch to remote mode first, then route the command. If that handoff cannot be made, return an RPC error and keep the previous goal state.
- Track one pending Claude goal action at a time. A second action while one is waiting for confirmation must return a busy error rather than enqueueing competing slash commands.

App changes remain minimal:

- Reuse `AgentGoalBar`, `SessionView` action state, and `sessionGoalAction`.
- No new Claude-specific UI branch unless the existing action copy needs a source-specific error message.

## Freshness and Replay

Freshness rules are stricter for active states:

- Active Claude goal state must include the current Claude `sessionId`.
- Active state is hidden if the app metadata does not have a matching `claudeSessionId`.
- On fork, resume, or reconnect, old transcript lines may be replayed for chat backfill, but they must not resurrect an active goal unless the adapter is processing the current Claude session and the source identity matches.
- `treatExistingAsProcessed` for chat replay must not suppress the goal-state refresh. Goal refresh is a separate read of the latest structured `goal_status` state for the current Claude session.
- Completed or cleared states can update the stored state for the same source session, but the UI remains hidden because only active states render.

On reconnect, the adapter must initially leave stale active state hidden until it has either refreshed the latest structured Claude goal state for the current session or marked the source unavailable.

## Privacy

Claude completion payloads can include evaluator `reason`, token counts, and duration. These fields are useful for local debugging but are not needed for the compact goal bar.

- Do not store evaluator `reason`, `tokens`, or `durationMs` in `AgentState`.
- Do not sync those fields to the app unless a future debug surface explicitly designs for them.
- Logs that include raw `goal_status` payloads must follow existing privacy-safe logging rules and avoid large evaluator text by default.

## Testing

Add or update focused tests:

- Claude mapper accepts `goal_status` active payloads and produces active `AgentGoalStatus`.
- Claude mapper accepts completed payloads and produces inactive completed state.
- Claude mapper rejects malformed payloads.
- Claude mapper includes `clear` and `edit` capabilities only behind slash-command/source gates.
- Session scanner can surface `goal_status` attachments without sending generic attachments to the chat protocol mapper.
- Session scanner keeps `RawJSONLinesSchema` / `sendClaudeSessionMessage` conversation-only and delivers `goal_status` through the side channel.
- Existing-session refresh reduces all current-session `goal_status` attachments in order and does not resurrect an older active sentinel after a later completed or cleared state.
- Claude runtime updates `agentGoalStatus` from `goal_status` attachments.
- Claude runtime does not update `agentGoalStatus` from `/goal ...` user text or command wrappers.
- Claude runtime withholds `clear` and/or `edit` capabilities until the implementation has fixture-backed confirmation for those actions.
- Claude `goal-action` queues `/goal clear` for clear and `/goal <objective>` for edit.
- Claude `goal-action` does not optimistically mutate `agentGoalStatus`.
- Claude `goal-action` isolates slash commands without clearing unrelated pending prompts.
- Claude `goal-action` returns busy when another Claude goal action is awaiting confirmation.
- Local-mode action tests prove the action goes through the existing local-to-remote handoff rather than writing into the interactive terminal.
- App goal-bar tests continue to prove actions render only from capabilities.

Manual verification:

- Start a Claude session with a `/goal ...` command from Happy.
- Confirm the bar appears only after the `goal_status` active attachment is observed.
- Tap edit, enter a new condition, and confirm the old text stays until Claude emits the replacement active state.
- Tap clear and confirm the bar hides only after Claude emits a structured inactive/cleared state.
- Watch CLI logs and the Claude JSONL file during the flow.

Run the relevant CLI mapper/runtime tests, app goal-bar tests, CLI typecheck, app typecheck, and `git diff --check`.

## Implementation Spike Gates

Before the implementation plan enables Claude action capabilities, it must produce fixture-backed answers to these gates:

- `/goal clear` emits a structured payload that can be mapped to inactive cleared state.
- `/goal <new condition>` while another goal is active emits a structured active payload matching the replacement objective.
- Local interactive mode either emits the same structured payloads and can route actions through the existing local-to-remote handoff, or local mode reports read-only/no capabilities.
- Remote-controlled SDK mode emits the same structured payloads and can route actions without batching with user prompts.

If any answer breaks confirmation semantics, the implementation must reduce Claude capabilities for that path instead of shipping an optimistic UI.
