# Session Idle Cleanup Guardrails Design

## Purpose

Happy sessions are being stopped while users are actively working. In the 2026-07-04 incident, the daemon received a `stop-session` RPC with `source: 'project-session-idle-stop'`, `reason: 'inactive-project-or-session'` and sent SIGTERM to two live sessions that the user considered in use. The stop itself executed cleanly (this was not a crash), but the *decision* to stop was wrong.

The root problem is that idle detection today is built on liveness signals instead of user-activity signals, and the daemon executes every stop request unconditionally. This design defines what "active" means, makes the daemon the final authority over policy-driven stops, and adds a grace window so a wrong candidate decision becomes a warning instead of a kill.

## Implementation Status (2026-07-04)

Phase 1 is **implemented in this repo** (`packages/happy-cli`) and is the load-bearing fix:

- Activity signals `pendingUserInput`, `lastUserInteractionAt`, `mode` are collected by the session (`apiSession.ts`), forwarded through `/session-runtime` (`controlServer.ts` / `controlClient.ts`), and stored on the tracked session (`run.ts`).
- `evaluateIdleStopGuard`, `resolveStopSessionMode`, `isPolicyStopSource`, and `readIdleStopGuardConfig` live in `sessionIdleReaper.ts` with unit tests.
- The `stop-session` RPC (`apiMachine.ts`) and `stopSession()` (`run.ts`) now take a context, infer `if-idle` for policy sources, run the guard, and return a **structured refusal** instead of killing an active session. The daemon reaper pull path re-validates through the same guard.

Not yet done (follow-up):

- **Two-phase grace + warning event** (candidate → warn → confirm) is designed below but not implemented; the guard alone already prevents the incident, and the warning event needs app work.

Done since (2026-07-04, follow-up review pass):

- **This repo**: `pendingUserInput` now also covers pending permission/approval requests (`agentState.requests` — the only signal for Codex approvals, which never open a tool call); the reaper candidate request forwards `pendingUserInput`/`lastUserInteractionAt`/`mode`; the local control-server `/stop-session` accepts `mode` and returns the structured refusal (`stopped`/`reason`/`guard`).
- **Root repo (`packages/web-ui`, aplus-dev-studio)**: `project-session-idle-stop` sends `mode: 'if-idle'`, parses the structured refusal (no `active:false` on refusal, reschedules instead); candidate selection excludes `pendingUserInput` and computes idleness from `max(lastActiveAt, lastUserInteractionAt)`; the `candidate request failed: 401` is fixed by accepting company happy tokens for shared machines (machine-company binding verified, session→project lookup company-scoped). See `specs/daemon-session-idle-reaper/` there.

Related, already landed on `main` and out of scope here: the spawn webhook timeout was reworked (`spawnWebhookWait.ts`, 15s soft / 60s final, delayed webhook resolves as success), which resolves the separate "세션 스폰 실패" false-failure symptom. The per-user-credentials `daemon.state.json` gap (F-03, `No daemon running, no state file found`) had zero occurrences in the incident logs and is tracked separately as a low-priority port-plumbing footnote.

## Goals

- Never stop a session that has a pending user interaction (AskUserQuestion, permission prompt) or an open tool call, regardless of who requested the stop.
- Base idle decisions on real user activity (last user message, permission answer, terminal input), not on process liveness or report timestamps.
- Give the daemon a local veto over policy-initiated stops, on both the reaper pull path and the `stop-session` push path.
- Convert immediate kills into a two-phase candidate → grace → confirm flow with a user-visible warning.
- Keep user-initiated stops (app "stop session" button, CLI) working exactly as today — instant and unconditional.
- Make every stop decision observable: source, reason, and the activity snapshot that justified it.

## Non-Goals

- Do not change how sessions are stopped once a stop is approved (SIGTERM + `preserveSessionForResume` stays).
- Do not implement the server-side candidate selection or the project orchestrator in this repo; this design specifies the contract they must follow.
- Do not remove the idle cleanup feature. Runaway daemon-spawned sessions still need reaping; the goal is precision, not deletion.
- Do not address the `session-idle-reaper candidate request failed: 401` auth bug beyond stating it as a prerequisite (it makes the pull path silently inert, which is fail-safe but also unobservable).

## Current Behavior (as-is)

Two independent cleanup paths can kill a session today.

### Path A: daemon idle reaper (pull)

`packages/happy-cli/src/daemon/sessionIdleReaper.ts`, wired into the 60s heartbeat in `packages/happy-cli/src/daemon/run.ts`.

1. Every heartbeat tick, the daemon builds an observation for each tracked claude/codex session:
   - `thinking` and `hasOpenToolCall` from the last `/session-runtime` webhook report.
   - `lastActiveAt = max(session process start time, last runtime report time)`.
2. It POSTs these to `${serverUrl}/api/daemon/session-idle-reaper/candidates` with `idleAfterMs` (default **5 minutes**, `HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS` override) and optional `presenceStaleMs`.
3. The server (not in this repo) returns candidate sessions.
4. The daemon calls `stopSession()` for **every candidate, with no local re-check** — even if the session reported `thinking: true` in the same tick (the existing unit test codifies this).

Known properties:

- `lastActiveAt` is effectively a liveness timestamp. Sessions report runtime state on every keep-alive via `reportDaemonRuntime` (`packages/happy-cli/src/api/apiSession.ts`), at most every 30 seconds (`DAEMON_RUNTIME_REPORT_MAX_INTERVAL_MS`). A connected session that has been untouched for hours still shows `lastActiveAt` within the last 30 seconds. Idle decisions therefore cannot come from this field; whatever the server uses instead is invisible to the daemon.
- A session waiting on **AskUserQuestion is deliberately reported as not-thinking** (commit 362e93f), so "Claude asked the user a question and is waiting for the answer" looks idle.
- Sessions without a metadata flavor default to `claude` and are included; `gemini` sessions are excluded.
- `HAPPY_DAEMON_SESSION_IDLE_REAPER_DISABLED=1` disables the whole path.
- In the incident environment this path 401s every tick and never returns candidates — it fails safe, but silently.

### Path B: `stop-session` RPC (push) — the path that actually fired

`packages/happy-cli/src/api/apiMachine.ts` registers a machine-scoped `stop-session` handler. Before this change it logged `source`/`reason` if present and then called `stopSession(sessionId)` **unconditionally**. The same handler serves:

- user-initiated stops from the app (`packages/happy-app/sources/sync/ops.ts` sends only `{ sessionId }`),
- policy-initiated stops. Per the web-ui maintainers, the actual kill is **sent by the web-ui client, not the server**: a browser timer (`web-ui App.tsx` → `stopSessionViaRpc` → `${machineId}:stop-session`) fires 5 minutes after that browser considers the project/session "left", using only agent-busy signals (`isAgentActiveFromSignals`: sending/streaming/thinking/open-tool-call) to gate it. The server-side reaper (`web-ui server/sessionIdleReaper.ts`, 10-minute + 2-minute project presence) only *computes candidates* and does not kill. This matches the incident source `project-session-idle-stop` / `inactive-project-or-session`.

The consequence: a **single stale or backgrounded browser tab** can send a kill for a session the user is actively using from another tab, a terminal, or mobile — none of which that tab's presence/activity check can see. `stopSession()` in `run.ts` then preserves the session for resume, sends SIGTERM (child process for daemon-spawned, raw PID for terminal-spawned), and drops it from tracking, with no distinction between "the user pressed stop" and "one browser's timer expired".

Because `packages/web-ui` / `vendor/happy` are not present in this repo, the daemon's `stop-session` handler is the **only enforcement point we can currently fix** — which is why the daemon guard (below) is the load-bearing change rather than a secondary safety net.

### Path C: dead-PID pruning

The heartbeat removes tracked sessions whose PID no longer exists. This is bookkeeping only and is out of scope.

### Why this over-cleans

1. The signals that mean "the user is here" — a pending AskUserQuestion, a permission prompt, a user message sent minutes ago, keystrokes in a local terminal — are either not collected or deliberately reported as idle.
2. The daemon, which is the only component that has (or could have) those signals, executes stop orders without consulting them.
3. A 5-minute idle threshold is far below normal human think-time between prompts.
4. Project-level inactivity (`inactive-project-or-session`) is allowed to override per-session activity, and the stop is immediate — no warning, no grace, no second look.

## Design

### 1. Activity ledger: define "active" from user actions

Extend the session runtime report so the daemon knows about user activity, not just agent busyness.

`SessionRuntimeState` (`packages/happy-cli/src/daemon/types.ts`) gains:

```ts
export interface SessionRuntimeState {
  thinking: boolean;
  hasOpenToolCall: boolean;
  pendingUserInput: boolean;     // AskUserQuestion or permission request awaiting the user
  lastUserInteractionAt?: number; // last user-originated action seen by the session
  mode?: 'local' | 'remote';      // local = attached terminal
  updatedAt: number;
}
```

The session process (`apiSession.ts` and the agent loops) updates `lastUserInteractionAt` when:

- a user message envelope arrives from the app or terminal,
- a permission request is answered,
- an AskUserQuestion is answered,
- the user switches mode (local/remote handoff),
- local mode receives terminal input (throttled — report at most once per 30s alongside the existing runtime report cadence).

`pendingUserInput` is true while `openAskUserQuestionIds` is non-empty or a permission request is outstanding. This *replaces* the current semantics where AskUserQuestion-waiting is folded into `thinking: false` and lost: `thinking` keeps its current meaning for UI purposes, and the reaper gets the dedicated flag instead.

The `/session-runtime` webhook (`controlServer.ts` → `onHappySessionRuntime` in `run.ts`) passes the new fields through. The reaper request (`buildDaemonSessionIdleReaperRequest`) forwards them per session so the server can select candidates from real activity:

```ts
{
  sessionId, agent, active: true,
  thinking, hasOpenToolCall,
  pendingUserInput,
  lastUserInteractionAt,   // absent if never observed
  mode,
  lastActiveAt,            // kept for backward compatibility, still liveness
}
```

### 2. Local stop guard: daemon has the last word on policy stops

Add a single pure function, e.g. `evaluateIdleStopGuard(session, now, config)` in `sessionIdleReaper.ts`, returning `{ allow: boolean, reason: string, snapshot: {...} }`. A policy-initiated stop is **denied** when any of these hold:

| Condition | Rationale |
| --- | --- |
| `thinking === true` | agent mid-turn |
| `hasOpenToolCall === true` | tool running; killing loses work |
| `pendingUserInput === true` | Claude is waiting on the user — the opposite of abandoned |
| `now - lastUserInteractionAt < idleAfterMs` | the user acted recently |
| `now - sessionStartTime < minSessionAgeMs` | freshly spawned sessions get a floor |
| `mode === 'local'` and `protectLocalSessions` | the user has a live terminal attached |
| runtime report missing/stale beyond `presenceStaleMs` and `now - sessionStartTime < hardIdleCapMs` | unknown state is not idle state |

One escape hatch: past `hardIdleCapMs` (default 2 hours with no observed user interaction and no pending input/open tool call), the guard allows the stop even when other soft protections apply, so zombie sessions still get cleaned up.

The guard applies to **both** paths:

- **Path A**: each server candidate passes through the guard before `stopSession()`. Denials are logged and counted (`skippedActive` in the tick result) instead of executed.
- **Path B**: see the RPC contract below.

### 3. `stop-session` RPC contract: force vs if-idle

Extend the RPC params with `mode?: 'force' | 'if-idle'`:

- `force` (and the default when `mode` is absent and `source` is absent): current behavior — unconditional stop. User-initiated stops from the app keep working untouched.
- `if-idle`: the daemon runs the stop guard first. If denied, it does **not** throw; it returns a structured refusal so the caller can back off and retry later:

```ts
// success
{ stopped: true, message: 'Session stopped' }
// refusal
{ stopped: false, reason: 'session-active', guard: 'pending-user-input', activity: { thinking, hasOpenToolCall, pendingUserInput, lastUserInteractionAt } }
```

Migration rule: while callers are being updated, the daemon treats any request whose `source` matches a known policy source (`project-session-idle-stop`, `session-idle-reaper`, or any `*-idle-*` source string) as `if-idle` even without `mode`. A batch policy must never get force semantics by omission. This rule alone would have prevented the 2026-07-04 incident.

### 4. Two-phase stop with grace window (Path A)

Replace immediate kills of reaper candidates with candidate → warn → confirm:

1. **Tick N — candidate.** The daemon records `pendingIdleStop = { sessionId, candidateAt }` and posts a session event (`session-idle-stop-warning`, carrying `graceMs` and the deadline) via the existing session event channel so the app and CLI can surface "이 세션은 N분 후 유휴 정리 예정" and the user can keep it alive by simply doing anything.
2. **Grace window** (`idleStopGraceMs`, default 5 minutes): any observed activity — new runtime report with user interaction, guard-protected state, or the session disappearing from server candidates — clears the pending record.
3. **Tick N+k — confirm.** Only when the session is *still* a server candidate, the guard *still* allows, and no interaction happened since `candidateAt`, does the daemon call `stopSession()`.

The pending map lives in daemon memory only; a daemon restart resets the cycle, which errs toward keeping sessions alive.

### 5. Threshold and default changes

- `DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS` stays **5 minutes** (unchanged) for the server request payload, but the guard now reuses it as the `recent-user-interaction` window. Because that window is keyed to real `lastUserInteractionAt` (not liveness), operators can raise it via env without accumulating zombies; 30 minutes is a reasonable target once the server side also selects candidates on activity.
- New env knobs implemented in `readIdleStopGuardConfig`, following the existing `readDaemonSessionIdleReaperConfig` pattern:
  - `HAPPY_DAEMON_SESSION_IDLE_MIN_AGE_MS` (default 600000 — 10 min)
  - `HAPPY_DAEMON_SESSION_IDLE_HARD_CAP_MS` (default 7200000 — 2 h)
  - `HAPPY_DAEMON_SESSION_IDLE_PRESENCE_STALE_MS` (default 300000 — 5 min; the guard's stale-runtime window)
  - `HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL` (default true; set `0`/`false`/`no` to allow reaping local-mode sessions)
- Planned but not yet implemented: `HAPPY_DAEMON_SESSION_IDLE_STOP_GRACE_MS` (two-phase grace, §4).
- Existing knobs (`...REAPER_AFTER_MS`, `...REAPER_PRESENCE_STALE_MS`, `...REAPER_DISABLED`) keep their meaning.

### 6. Server-side contract (not implemented in this repo)

The internal candidates endpoint and the project orchestrator must adopt:

- Candidate selection uses `lastUserInteractionAt` and `pendingUserInput` from the daemon report. `lastActiveAt` alone is a liveness signal and must not drive idle decisions. Sessions with `pendingUserInput: true` are not candidates regardless of age (until `hardIdleCapMs`).
- `project-session-idle-stop` sends `mode: 'if-idle'` and honors `{ stopped: false }` refusals with backoff (e.g. re-evaluate after ≥ the daemon's grace window) instead of retrying immediately or escalating to force.
- Project-level inactivity may *nominate* sessions but never overrides a per-session refusal.
- Prerequisite: fix the credentials/audience mismatch behind the recurring `candidate request failed: 401` so the pull path actually functions and is observable.

### 7. Observability

- Every guard decision (allow and deny) logs one structured line: `[session-idle-guard] sessionId=... source=... decision=deny guard=pending-user-input thinking=false hasOpenToolCall=false lastUserInteractionAt=...`.
- `stopSession()` gains an optional `context` argument (`source`, `reason`, `initiator: 'user' | 'policy'`) that is written into the preserve-for-resume log line and posted with the `session-end` event, so the app can show *why* a session ended instead of it silently vanishing.
- The reaper tick result grows `skippedActiveSessions` and `pendingGraceSessions` counters, logged whenever non-zero.

## What Changes Where

| Area | File(s) | Change |
| --- | --- | --- |
| Runtime state shape | `packages/happy-cli/src/daemon/types.ts` | add `pendingUserInput`, `lastUserInteractionAt`, `mode` |
| Session-side reporting | `packages/happy-cli/src/api/apiSession.ts` (+ agent loops for user-input hooks) | track/report new fields; stop conflating AskUserQuestion-wait with idle |
| Webhook plumbing | `packages/happy-cli/src/daemon/controlServer.ts`, `controlClient.ts`, `run.ts` | pass new fields through `/session-runtime` |
| Guard + two-phase reaper | `packages/happy-cli/src/daemon/sessionIdleReaper.ts` | `evaluateIdleStopGuard`, pending-candidate state, new config knobs, richer request payload |
| RPC contract | `packages/happy-cli/src/api/apiMachine.ts` | `mode: 'force' | 'if-idle'`, policy-source inference, structured refusal |
| Stop context | `packages/happy-cli/src/daemon/run.ts` | `stopSession(sessionId, context)`, session-end annotation |
| App (follow-up) | `packages/happy-app` | render idle-stop warning event; show stop reason on ended sessions |

## Testing

Unit tests (Vitest, colocated, extending `sessionIdleReaper.test.ts`):

- Guard denies for each protection condition independently (thinking, open tool call, pending user input, recent interaction, min age, local mode, stale runtime), and allows past `hardIdleCapMs`.
- Reaper tick: candidate with guard-denied state is skipped and counted, not stopped.
- Two-phase: first candidate tick warns and does not stop; confirm tick stops only when still-candidate + still-allowed + no interaction; interaction during grace clears the pending record.
- `stop-session` RPC: no source/mode → force (current behavior preserved); `source: 'project-session-idle-stop'` without mode → if-idle; if-idle refusal returns `{ stopped: false }` with a guard reason and does not SIGTERM.
- Config parsing for the new env knobs, including invalid values falling back to defaults.
- Request builder includes `pendingUserInput`/`lastUserInteractionAt`/`mode` and keeps `lastActiveAt` for compatibility.

Manual smoke:

1. Start a daemon-spawned session, open an AskUserQuestion, wait past `idleAfterMs`: session must survive and log a guard denial.
2. Send `stop-session` with `source: 'project-session-idle-stop'` against an active session: expect a structured refusal, no SIGTERM.
3. Leave a session truly untouched past threshold + grace: expect one warning event, then a clean stop whose session-end carries the policy source.
4. Press stop in the app: session dies immediately (force path unchanged).

## Rollout

Phase 1 (this repo, happy-cli): activity ledger, guard, RPC contract with policy-source inference, two-phase grace, new defaults. Safe to ship ahead of server changes — the policy-source inference immediately downgrades `project-session-idle-stop` from force to if-idle, and unknown new fields are simply absent from old sessions (guard then leans on the stale-runtime protection).

Phase 2 (internal server + orchestrator): candidates endpoint consumes the new activity fields; `project-session-idle-stop` sends `mode: 'if-idle'` and backs off on refusal; 401 auth fix.

Phase 3 (app): show the idle-stop warning and the stop reason on ended sessions.

Rollback: `HAPPY_DAEMON_SESSION_IDLE_REAPER_DISABLED=1` still disables Path A entirely; the Path B guard can be bypassed per-call with explicit `mode: 'force'` if a policy caller must hard-kill.

## Security Considerations

The refusal payload (`activity` snapshot) contains only booleans and timestamps — no message content, paths, or tokens. The stop guard does not create a way for a compromised server to *keep* sessions alive maliciously (it only restricts stopping), and force mode remains available to the authenticated machine-scoped RPC channel exactly as today.
