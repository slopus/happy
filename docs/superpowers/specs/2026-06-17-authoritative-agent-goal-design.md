# Authoritative Agent Goal Design

## Goal

Make agent goals visible in Happy only when Claude or Codex exposes an authoritative goal state. Happy presents and routes goal controls, but the agent remains the owner of the goal lifecycle.

This design sets the product direction for GitHub issue #1349 without introducing a fake Happy-controlled goal state.

## Product Principle

Happy must not infer an active goal from chat text, `/goal ...` user messages, command echoes, or local-command stdout. Those signals only prove that a command was sent or displayed. They do not prove that the agent accepted, retained, cleared, or completed the goal.

The app can show a current-goal bar only from an agent-owned source of truth:

- a Claude SDK goal metadata/event/status API
- a Codex app-server goal metadata/event/status API
- a future agent protocol event with equivalent semantics

If no authoritative source exists for an agent, Happy does not render a "Current goal" bar and does not expose goal management actions for that session.

## Authoritative Source Criteria

A source counts as authoritative only if it is all of the following:

- agent-owned: emitted by Claude, Codex, or the agent protocol, not by Happy's chat parser
- machine-readable: structured metadata, event payload, or typed status response, not prose
- session-scoped: tied to the agent session or thread whose UI is being rendered
- lifecycle-aware: can distinguish active, inactive, cleared, completed, and unavailable states
- replay-safe: includes enough identity or timing to avoid treating old transcript data as current
- capability-aware: explicitly states which actions, if any, Happy may offer

If a source fails any criterion, the adapter must treat goal status as `unavailable`.

## Scope

- Add a shared read model for agent-owned goal state.
- Surface active goals in the Happy session UI above the composer.
- Keep existing `/goal ...` message chip behavior as a display affordance only.
- Support Claude and Codex through the same UI contract, while allowing either adapter to report `unavailable` when the agent does not expose goal state.
- Do not implement Happy-owned goal persistence, enforcement, stop-hook continuation logic, or transcript parsing as a fallback.
- Do not show a last-sent goal in the composer goal bar. Last-sent messages may remain visible only in chat history.

## Data Contract

Add an optional `agentGoalStatus` field to encrypted `AgentState`. `AgentState` is the right layer because the goal is mutable runtime state, similar to permission requests, not static session metadata.

Conceptual shape:

```ts
type AgentGoalStatus =
  {
    source: 'claude' | 'codex';
    observedAt: number;
    sourceSessionId?: string;
    sourceRevision?: string | number;
  } & (
    | {
      status: 'unavailable';
      reason?: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown';
    }
    | {
      status: 'inactive';
      reason?: 'none' | 'cleared' | 'completed' | 'unknown';
    }
    | {
      status: 'active';
      text: string;
      capabilities?: {
        clear?: boolean;
        stop?: boolean;
        edit?: boolean;
      };
      progress?: {
        currentStep?: number;
        totalSteps?: number;
        steps?: Array<{
          text: string;
          status: 'pending' | 'in_progress' | 'completed';
        }>;
      };
    }
  );
```

The `progress` field is optional and only appears if the agent source reports real steps. Happy does not derive progress from TodoWrite or from assistant text in this design.

`sourceSessionId` and `sourceRevision` are optional because each agent exposes identity differently. Adapters must fill them when available. If an adapter cannot tie an active state to the current agent identity or another replay-safe revision, it must not preserve that active state across reconnect, resume, app reload, or thread replacement.

## Adapter Behavior

Claude and Codex adapters are responsible for translating their own authoritative goal information into `agentGoalStatus`.

Required rules:

- Update `agentGoalStatus` only from an agent-owned metadata, event, or status response with explicit goal semantics.
- Do not update `agentGoalStatus` from outbound user text such as `/goal finish the task`.
- Do not update `agentGoalStatus` from the existing UI parser that turns `/goal ...` into a message chip.
- On reconnect or resume, refresh goal state from the agent if the agent supports it. Until refreshed, report `unavailable` rather than replaying stale state as active.
- On `/clear`, clear the visible goal only if the agent reports `inactive`, or if the agent protocol explicitly defines `/clear` as clearing its goal state and confirms it.
- When an agent session or thread id changes, mark the previous `agentGoalStatus` as `unavailable` unless the new agent identity explicitly carries the same goal state forward.
- When a source reports unsupported goal state, write `unavailable` with `reason: 'unsupported'` so the UI stays hidden and tests can assert the distinction from inactive goals.

If a user invokes a goal action from the UI, Happy sends the corresponding agent-supported command or control request. The app does not optimistically mutate the goal bar; it waits for the next authoritative update.

## Freshness and Lifecycle

The goal bar is a live status surface, not a historical summary.

Rules:

- An `active` goal may be shown only when it was observed for the current connected agent session or refreshed from a persistent agent-owned state store after reconnect.
- If the Happy app reloads before the CLI reconnects, stale encrypted `AgentState` must not render an active bar by itself.
- If the session is disconnected and the adapter cannot confirm that the agent goal still exists, the adapter reports `unavailable` and the UI hides the bar.
- If the agent can prove that goal state persists across restart or resume, the adapter may show `active` after it refreshes that state.
- `inactive` means the agent authoritatively reports no active goal. `unavailable` means Happy cannot know.

This distinction matters for UX: inactive can support calm "no current goal" copy in future debug surfaces, while unavailable must not imply that no goal exists.

## Capability and Action Contract

Happy renders action buttons only from `capabilities`.

Action rules:

- `clear`: send the agent-supported clear request. Keep the bar visible until the agent reports `inactive` or `unavailable`.
- `stop`: send the agent-supported stop/pause request. Keep the bar visible until the agent reports a new state.
- `edit`: open an agent-supported edit flow only if the agent exposes one. Do not implement edit by pre-filling `/goal ...` unless the agent defines that as its edit protocol.
- During an in-flight action, disable only that action button and show progress locally.
- If the action fails or times out, show a small error and keep the last authoritative state.
- If no capabilities are reported, render the bar as read-only.

The app can still allow users to type `/goal clear` manually. That user message does not mutate `agentGoalStatus` unless the agent later confirms the resulting state.

## User Experience

Add an `AgentGoalBar` above the composer.

Render rules:

- `active`: show the bar.
- `inactive`: hide the bar.
- `unavailable`: hide the bar.
- missing `agentGoalStatus`: hide the bar.

Bar content:

- target icon
- label: `Current goal`
- one-line goal text with ellipsis
- tap opens the full goal text
- action buttons only for capabilities explicitly reported by the agent

Copy must avoid implying Happy ownership. The session info/debug surface may identify the source as `Claude goal` or `Codex goal`, but the compact bar can stay short as `Current goal` because it is only rendered from authoritative state.

The existing chat chip under `/goal ...` remains useful, but it means "sent as goal", not "current goal". It must not create or update the composer goal bar.

The screenshot-style progress popover is out of scope for the first implementation unless the agent source provides `progress`. Without agent-provided progress, showing a step list would be another inferred state.

## Error Handling

- If the adapter cannot read goal state, write or leave `status: 'unavailable'`.
- If a goal action fails, keep the previous visible state until the agent reports a new state. Surface the failure as a small error toast or status message.
- If the agent reports malformed goal data, ignore that update and keep the previous valid state only if it is still fresh for the current connected run; otherwise report `unavailable`.
- Older CLIs or agents that do not support goal state must behave as they do today, with no current-goal bar.

## Implementation Phases

Phase 1 defines the contract without changing visible behavior:

- add shared schema/types for `AgentGoalStatus`
- add parser/normalizer tests for accepted and rejected states
- add a hidden UI component that renders only from explicit active state
- add adapter tests proving user text cannot create active state

Phase 2 wires the first authoritative agent source:

- identify a real Claude or Codex goal metadata/event/status source
- map that source into `agentGoalStatus`
- expose only capabilities that the source explicitly supports
- keep unsupported agents hidden

Phase 3 expands progress/actions only when the agent source supports them:

- render progress only from structured agent progress
- add clear, stop, or edit buttons only after adapter-level confirmation tests exist

If Phase 2 cannot find an authoritative source in Claude or Codex, implementation must stop after Phase 1 and leave the bar hidden.

## Testing

Add focused tests for the contract rather than broad UI snapshots:

- schema tests accept active, inactive, and unavailable goal states
- schema tests reject active goal states without text
- schema tests reject malformed capabilities and progress payloads
- adapter tests prove user `/goal ...` text does not update `agentGoalStatus`
- adapter tests prove only authoritative goal events or metadata update `agentGoalStatus`
- adapter tests prove unsupported or malformed sources become `unavailable`
- reconnect tests prove stale active state is not shown before refresh
- identity tests prove thread/session replacement invalidates prior active goals
- action tests prove clear/stop/edit do not optimistically hide or mutate the bar
- app tests render `AgentGoalBar` only for active state
- app tests hide the bar for inactive, unavailable, and missing state
- app tests show action buttons only from reported capabilities
- regression tests keep `/goal ...` message chips independent from `AgentGoalBar`

Run the relevant CLI adapter tests, app component tests, app typecheck, CLI typecheck, and diff hygiene checks.

## Open Source Issue Status

This design does not close #1349 by itself. It defines the correct ownership boundary and UI contract. The implementation can claim support for Claude or Codex only when that specific adapter can provide authoritative goal state and the app can display and manage that state without falling back to transcript inference. If neither adapter exposes an authoritative source, the implementation must keep the current-goal bar hidden instead of shipping a partial fake state.
