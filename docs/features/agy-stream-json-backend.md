# agy Stream-JSON Backend

Feature document for the Happy CLI integration with the agy (Antigravity) CLI
through its native stream-json mode.

## Goal

Drive agy as a single long-lived child process per Happy session, eliminating
per-turn cold starts (harness boot, keyring, eligibility checks) while
supporting multi-turn conversation, mid-session model switching, and crash
recovery with full context preservation.

## Core Entry Points

| File | Role |
|---|---|
| `packages/happy-cli/src/agy/runAgy.ts` | Session loop: remote message intake, metadata updates, turn orchestration |
| `packages/happy-cli/src/agy/AgyBackend.ts` | `AgentBackend` implementation owning the persistent agy child process |
| `packages/happy-cli/src/agy/streamJson.ts` | NDJSON stream parser (text deltas, thinking, tool calls, results) |
| `packages/happy-cli/src/agy/discoverModels.ts` | `agy models` discovery + slug/display-name resolution |
| `packages/happy-cli/src/agy/AgySdkBackend.ts` | Alternative Python SDK-bridge backend (model is passed per-turn, so it needs no restart-on-model-change) |

## Architecture

```
Happy iOS/Web client
   │  (encrypted WebSocket; user messages carry meta.model / meta.permissionMode)
   ▼
runAgy.ts  session.onUserMessage
   │  ├─ backend.setModel(meta.model)          ← may trigger process restart
   │  └─ messageQueue.push(text)
   ▼
AgyBackend (persistent process driver)
   │  spawn: agy --input-format stream-json --output-format stream-json
   │            [--dangerously-skip-permissions] [--model <name>]
   │            [--conversation <id>] --add-dir <cwd>
   ▼
agy child process  ──NDJSON over stdout──▶  StreamJsonParser ──▶ AgentMessage events
```

## Data Flow

1. **Startup**: `startSession()` → `ensureChildRunning()` → `spawnPersistentChild()`.
   Startup completes when the child emits `{"event":"init","conversation_id":...}`;
   the conversation id is stored and surfaced via `onConversationId` listeners.
2. **Turn**: `sendPrompt()` writes `{"event":"user","message":{"content":...}}` to
   the child's stdin and resolves when a `result` event with `status: "SUCCESS"`
   arrives for the turn. Turns are serialized by the message queue in `runAgy.ts`.
3. **Model switch**: the client's model picker applies the new model to the
   *next* user message via `meta.model`. `runAgy.ts` calls
   `backend.setModel()` and updates session metadata (`currentModelCode`) so the
   UI reflects the selection immediately.

## Model Switching Restarts the Process

`--model` is a **spawn-time flag**; a running agy process keeps using the model
it was started with. To make client-side model changes actually take effect:

- `AgyBackend.setModel()` compares the resolved model against the current one.
  Unchanged → no-op.
- If the child is alive and **no turn is running**, the child is killed
  (`SIGTERM`) immediately; the next `sendPrompt()` respawns with the new
  `--model` and the same `--conversation <id>` (context preserved).
- If a turn **is running**, killing mid-turn would fail the in-flight prompt,
  so the restart is deferred via `pendingModelRestart` and executed in the
  `sendPrompt()` `finally` block after the turn settles.

Consequence: the model reported in session metadata and the model actually in
use can briefly diverge while a turn is in flight; they converge once the turn
completes and the next prompt respawns the process.

`AgySdkBackend` does **not** need this: it passes `model` inside every `chat`
bridge request, so changes apply on the next turn with no restart.

## Key Data Structures

- `AgyBackendOptions` — `cwd`, `permissionMode`, `model`, `models`
  (discovered list for slug resolution), `conversationId`, `spawnFn`
  (injectable for tests), `maxRetries`.
- Stream-json events (see `streamJson.ts`): `init`, `step_update`
  (text/thinking/tool deltas), `result` (`SUCCESS` | `ERROR`).
- `DiscoveredModel { code, value, slug?, description? }` — `code`/`value` are
  display names accepted by `agy --model`; `resolveAgyModelName()` maps slugs
  (e.g. `gemini-3.7-flash-high`) to display names.

## External Dependencies

- `agy` CLI on PATH (resolved via `resolveAgyBin()`), with stream-json support
  and the `agy models` subcommand for discovery.
- Google OAuth / network access for agy's eligibility checks.

## Error Paths

- **Transient startup failures** (eligibility check, EOF, TLS handshake,
  rate limit — see `isRetryableAgyError`): retried up to `maxRetries` times
  with linear backoff inside `ensureChildRunning()`.
- **Non-retryable startup failure**: `startSession()`/`sendPrompt()` reject;
  the turn ends as failed.
- **Mid-turn process exit**: the active turn rejects with
  "agy process exited unexpectedly"; the *next* prompt respawns the process
  with `--conversation <id>`.
- **Stale events from a replaced process**: a killed process's `close`/`error`/
  stdout events arrive asynchronously and may land after a replacement has
  already spawned (model-change restart). All child-event handlers are guarded
  by `this.child === child` so a stale process can neither clear the live
  reference nor feed/reject the active turn. (`cancel()` nulls the reference
  before `close` arrives, so the turn-rejection path also fires on
  `this.child === null` to keep aborts working.)
- **Model discovery failure**: falls back to the static `AGY_MODELS` list.

## Testing

`npx vitest run src/agy/AgyBackend.test.ts src/agy/streamJson.test.ts`

Covers: persistent multi-turn in one process, startup retry, single error
status on failed turns, mid-turn crash, and model switching (no-op on
unchanged model, immediate restart when idle, deferred restart mid-turn,
respawn args carrying new `--model` + preserved `--conversation`).

## Change Log

- 2026-08-21: Fix race where a late `close` event from the killed process
  cleared the replacement's `this.child` reference after a model-change
  restart, silently dropping the next prompt (`this.child?.stdin?.write` on
  null) and hanging the turn forever. Child-event handlers are now guarded by
  identity checks.
- 2026-08-21: `setModel()` now restarts the persistent process on model change
  (deferred while a turn is running), so client-side model switching takes
  effect on the next prompt instead of only after a crash/respawn.
- 2026-08-21: Native persistent single-process stream-json driver introduced
  (replaces per-turn process spawning), with explicit conversation id
  management and startup retry.
