# AgentParty Codex Debate Design

## Goal

Extend the AgentParty proof of concept from user-directed group replies into a
bounded, visible two-Agent debate. Every participant in this release uses
Codex with the default launch profile `gpt-5.6-luna` and reasoning effort
`low`. The user can see and stop a debate; no background loop may outlive its
configured limit.

## Scope

### Included

- A room-level **自动辩论** toggle and a maximum of 1–10 debate rounds
  (default 10).
- A debate starts only from one user message that explicitly mentions exactly
  two room members while 自动辩论 is enabled.
- One round is one response from each debater. Therefore the hard upper bound
  is 20 agent messages for a ten-round debate.
- Sequential turn-taking: opening positions are A then B; every later turn
  receives the complete public room transcript, including the opponent's most
  recent response.
- A durable debate record: participant IDs, source message ID, current turn,
  maximum rounds, state, and stop reason.
- A visible `停止辩论` action that blocks all future scheduling without claiming
  that a remote Codex process was forcibly terminated.
- Codex-only Agent profiles with editable model and effort fields. The initial
  defaults are `gpt-5.6-luna` and `low`.
- End-to-end forwarding of the selected Codex model and effort through the
  Paws Agent SDK, server protocol, and remote daemon spawn path.

### Excluded

- Three-or-more-party free-for-all debates.
- Unbounded autonomous replies.
- Making hidden chain-of-thought, tool calls, credentials, or private remote
  session content visible in the group.
- Applying Codex model/effort controls to Claude, Gemini, OpenCode, or
  OpenClaw.

## User experience

The room header shows two independent controls:

- `自动接话` retains the existing normal-chat behavior.
- `自动辩论` enables bounded two-person exchanges and exposes the maximum-round
  selector.

When a user sends `@张三 @李四 辩论：一见钟情是否适合进入长期关系？`, AgentParty
creates a debate card in the timeline. It shows `第 1 / 10 轮`, the next
speaker, and a stop action. Timeline messages carry `立论` for each opening
position and `交锋 N` for each subsequent response. On completion, the card
reads `辩论已在第 N / 10 轮结束`; on manual stopping, it reads `已停止，未再派发新
回合`.

The Agent management panel is Codex-only. Each profile presents a model
selector and effort selector, seeded with `gpt-5.6-luna` / `low`. The form does
not expose choices that this release cannot deliver.

## Debate scheduler

`GroupRoomService` owns debate state and serializes a room's debate turns.
The scheduler is intentionally not driven by observed public messages: doing
so would make reloads and replayed events capable of scheduling duplicates.

1. Validate a user message and resolve its mentions.
2. If 自动辩论 is off, or its target count is not exactly two, retain normal
   mention routing.
3. If it is on and exactly two members are mentioned, persist a `running`
   debate before sending the first directed task.
4. Schedule one turn at a time in stable member order. The task prompt tells
   the current speaker whether it is an opening position or a response, names
   the opposing position, and asks for a concise public answer.
5. Once both participants have spoken, increment the completed-round counter.
   If it equals `maxRounds`, persist `completed` and publish the terminal
   system message. Otherwise schedule the first participant's next turn.
6. A stop action atomically changes the state to `stopped`, aborts only the
   local scheduler/subscription, and prevents any continuation even if an
   in-flight remote response arrives later.

Only one debate can be active in a room. A request to start another while one
is running returns a visible conflict instead of merging their transcripts.
On server restart, a persisted `running` debate becomes `interrupted`; it is
never replayed automatically. This follows the existing POC's durable
coordination rule.

## Codex launch contract

The existing Paws Agent `SpawnSessionInput` currently carries only machine,
directory, agent type, and provider token. Add optional Codex-only fields:

```ts
agent: 'codex'
model: 'gpt-5.6-luna'
effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
```

The SDK validates that model and effort travel only with `agent: 'codex'`.
The server forwards them unchanged to the selected machine's spawn RPC. The
daemon validates the enum and translates them into Codex launch arguments
(`--model` and `--effort`). Invalid or unsupported values return an explicit
spawn error; they must not silently fall back to an unrequested model.

AgentParty freezes the chosen model and effort into the room member snapshot
when a room is created. Later edits affect newly created rooms only, ensuring
an existing debate has reproducible participant settings.

## Failure handling and safety

- A failed participant turn ends the active debate as `failed`; no next turn
  is scheduled. The timeline names the failed member and retains the safe error
  message.
- A stop or restart never claims to kill a remote session. It only terminates
  local coordination and observation.
- Maximum rounds are validated at every scheduling decision, not only in the
  UI.
- Recovery-code account credentials remain memory-only and unrelated to model
  or debate persistence.
- Public context stays bounded and uses the existing public-message envelope;
  private tool results and hidden reasoning remain excluded.

## Acceptance criteria

1. Two explicit mentions with 自动辩论 enabled produce two opening positions
   and then alternate until the configured number of full rounds completes.
2. A 10-round configuration produces no more than 20 Agent responses and one
   terminal completion record.
3. Stopping during a turn produces no subsequent turn after the in-flight
   result arrives.
4. A process restart marks a running debate interrupted and does not resume
   it.
5. Each participant session spawn receives `agent=codex`, the profile model,
   and the profile effort; daemon tests prove the corresponding Codex command
   arguments.
6. A non-Codex profile cannot be created through the UI or API in this release.
7. Existing normal group chat and explicit multi-mention replies still work
   when 自动辩论 is disabled.

## Test strategy

- Unit-test debate state transitions, maximum-round counting, selection order,
  stop behavior, and restart interruption.
- Extend SDK/server/daemon contract tests for model and effort validation and
  exact launch forwarding.
- Add UI tests for the room controls, Codex profile defaults, active-debate
  status, and stop affordance.
- Run a real two-Codex-agent acceptance case with a low-effort luna profile,
  stopping one active debate and completing another to the configured cap.
