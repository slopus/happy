# PRD: Codex Native TUI and Remote Handoff

Status: Local draft, not published upstream.
Date: 2026-05-04

## Problem Statement

Happy's Codex integration currently behaves like a remote structured client, not like a first-class Codex CLI experience. Terminal users do not get the native Codex TUI by default, while mobile users also do not get enough visibility into Codex tool results. This makes Codex feel less capable than Claude in Happy, even though Codex itself supports both a native interactive TUI and an app-server protocol with resumable threads.

The user needs a practical workflow where they can start Codex from the terminal, use the native TUI locally, walk away, send a message from mobile, and later regain terminal control without losing the Codex thread. The solution must be upstream-friendly, avoid mobile app changes for now, and avoid treating unstable Codex transcript internals as the main protocol.

## Verified Capabilities

- Native Codex can resume a specific session with `codex resume <session-id>`.
- Codex app-server can resume the same session id through `thread/resume`.
- Happy already stores Codex's resumable id as `codexThreadId`.
- Native Codex writes JSONL transcript files under the local Codex home, but that format is internal and not suitable as the first-class handoff protocol.
- Launching native Codex with inherited stdio means Happy cannot parse the TUI stream directly.
- New native sessions can be discovered by observing Codex's local state files, but that discovery is not as strong as a first-class session-created event from Codex.

## Solution

Add a Codex mode loop that mirrors Claude's local/remote model where it makes sense:

- Local mode launches native Codex with inherited stdio.
- Remote mode uses the existing Codex app-server integration.
- Terminal starts default to local mode.
- Daemon starts always use remote mode.
- Mobile/web messages arriving during local mode immediately switch the session to remote mode and process the queued message.
- Remote mode stays active after a mobile turn until the terminal user explicitly switches back.
- Terminal switch-back uses the same gesture as Claude remote mode.
- Both local and remote modes preserve the same Codex thread through `codexThreadId` where possible.

Also fix the remote Codex data path so command completions include result content and execution metadata in synced session data. No mobile app renderer changes are included in this PR.

## User Stories

1. As a terminal Codex user, I want `happy codex` to open native Codex TUI, so that local usage feels like Codex.
2. As a mobile user, I want a message sent from mobile to take over a local Codex session immediately, so that remote work does not depend on someone touching the terminal.
3. As a terminal user, I want to switch back from remote Codex mode to native Codex TUI, so that I can continue locally after using mobile.
4. As a Codex user, I want local and remote turns to continue the same Codex thread, so that context is preserved across devices.
5. As a daemon user, I want daemon-spawned Codex sessions to stay remote, so that a background process does not try to own an interactive terminal.
6. As a mobile user, I want Codex command output to be present in session data, so that command results are not lost.
7. As a contributor, I want implementation phases with review gates, so that a large behavior change stays reviewable.
8. As a maintainer, I want ambiguous new-session id discovery to fail visibly, so that Happy does not attach mobile to the wrong Codex thread.
9. As a maintainer, I want JSONL transcript tailing to be optional, so that Happy does not depend on unstable internal Codex storage for correctness.

## Non-Goals

- No mobile app renderer changes.
- No mobile protocol/schema changes unless required to preserve existing behavior.
- No shared remote PTY or ANSI terminal streaming.
- No arbitrary mobile keystroke forwarding into native Codex TUI.
- No reliance on Codex JSONL transcript files as the primary handoff mechanism.
- No daemon-owned native TUI.
- No attempt to preserve native TUI screen state, scrollback, cursor position, or alternate-screen buffer across switches.

## Phase 1: Remote Data Correctness

Goal: make Codex remote/app-server tool results complete enough for current and future mobile rendering.

Implementation requirements:

- Preserve Codex command completion output in synced session data.
- Include command output, exit code, duration, status, and cwd where available.
- Mark failed commands as error results when Codex reports a failed execution status.
- Keep compact mobile rendering unchanged for now.
- Avoid app package edits.

Automated tests:

- Codex app-server client maps command completion payloads with output and exit metadata.
- Codex session protocol mapper emits tool result content instead of a null result for command completion.
- Existing Codex patch, diff, reasoning, and turn lifecycle mapping tests keep passing.
- App-side raw normalization accepts the enriched result payload without schema changes.
  Current app normalization intentionally keeps compact rendering unchanged and does not
  surface the enriched result yet; a later app-renderer PR can consume the raw envelope
  `result` payload for full command output display.

Review gate:

- Subagent review focused on protocol compatibility, data shape stability, and regression risk.

Manual tests:

- Start a remote Codex session and ask it to run a command with stdout.
- Confirm synced session data contains the command output.
- Ask it to run a failing command.
- Confirm synced session data contains failure status and error/output details.

## Phase 2: Codex Mode Loop

Goal: introduce Codex local and remote launchers under one mode loop, following Claude's proven shape without copying Claude-specific internals blindly.

Implementation requirements:

- Add a Codex mode loop with `local` and `remote` modes.
- Terminal-started `happy codex` defaults to local mode.
- `--happy-starting-mode remote` starts app-server remote mode.
- Daemon-spawned Codex always starts remote.
- Local mode launches native Codex with inherited stdio.
- Remote mode uses the existing app-server implementation.
- Preserve PR1 startup defaults across both modes where applicable.

Automated tests:

- Command parsing recognizes Codex starting mode.
- Terminal start defaults to local.
- Daemon start forces remote.
- Local launcher builds the correct native Codex command for fresh and resumed sessions.
- Remote launcher delegates to existing app-server behavior.

Review gate:

- Subagent review focused on process lifecycle, command construction, and parity with Claude where appropriate.

Manual tests:

- Run `happy codex` from an interactive terminal and confirm native Codex TUI opens.
- Run `happy codex --happy-starting-mode remote` and confirm app-server remote mode opens.
- Spawn Codex through daemon and confirm it does not try to use local TUI.

## Phase 3: Thread Id Discovery And Continuity

Goal: preserve Codex context across local and remote mode switches.

Implementation requirements:

- If `codexThreadId` is known, local mode must use `codex resume <codexThreadId>`.
- If `codexThreadId` is known, remote mode must use app-server `thread/resume`.
- If a local native session starts without a known id, Happy must discover the new Codex id from Codex local state.
- Discovery must be bounded, cwd-aware, and time-window-aware.
- If discovery is ambiguous, Happy must surface a clear error instead of choosing a random thread.
- Once discovered, Happy must store `codexThreadId` in session metadata.

Automated tests:

- Resume command construction uses positional `codex resume <id>`, not a non-existent native `--resume` flag.
- Discovery chooses the matching new thread when exactly one local Codex thread appears for the cwd and launch window.
- Discovery rejects zero matches.
- Discovery rejects multiple plausible matches.
- Metadata updates persist the discovered or resumed `codexThreadId`.

Review gate:

- Subagent review focused on race conditions, local state parsing, failure modes, and platform portability.

Manual tests:

- Start a new local Codex session from Happy and confirm Happy records the new `codexThreadId`.
- Switch to remote and verify app-server resumes the same id.
- Switch back to local and verify native Codex resumes the same id.
- Start another Codex outside Happy in the same cwd during discovery and confirm Happy detects ambiguity instead of attaching incorrectly.

## Phase 4: Mobile Handoff

Goal: let mobile/web messages take over a local native Codex session immediately.

Implementation requirements:

- While local mode is active, any queued Happy user message triggers an immediate local abort/switch.
- The mobile message must be preserved and processed in remote mode.
- Local turn state must be closed consistently.
- Remote mode must remain active after the mobile turn completes.
- No terminal confirmation is required.

Automated tests:

- Queued message during local mode causes switch to remote.
- Queued message is not dropped during switch.
- Abort handling closes the local process and resets local handlers.
- Remote mode receives the queued message after switch.

Review gate:

- Subagent review focused on queue semantics, cancellation behavior, and message loss risks.

Manual tests:

- Start `happy codex` locally.
- Send a message from mobile/web while local TUI is active.
- Confirm native TUI exits and the mobile message is processed remotely.
- Confirm session remains remote after the turn completes.

## Phase 5: Terminal Switch-Back

Goal: let terminal users regain native Codex TUI after remote/mobile use.

Implementation requirements:

- Codex remote Ink display supports the same switch-back gesture as Claude.
- Double-space switches from remote mode back to local mode.
- Switch-back resumes the current `codexThreadId`.
- Remote mode must not auto-switch to local after a mobile turn.

Automated tests:

- Remote display invokes switch callback on double-space.
- Mode loop switches remote to local on explicit switch.
- Switch-back requires a known `codexThreadId` or performs safe bounded discovery after local launch.

Review gate:

- Subagent review focused on terminal UX parity, lifecycle cleanup, and switch-back edge cases.

Manual tests:

- Start local, hand off to mobile, wait for remote completion.
- Press double-space in terminal remote mode.
- Confirm native Codex TUI resumes the same thread.
- Send another mobile message and confirm handoff still works.

## Phase 6: End-To-End Verification

Goal: prove the implementation works as a first-class workflow before proposing upstream.

Manual checklist:

- Fresh terminal start opens native Codex TUI.
- Fresh terminal start records `codexThreadId`.
- Remote start still works without native TUI.
- Daemon start stays remote.
- Mobile message during local mode immediately switches to remote.
- Mobile message is processed exactly once.
- Command output from remote mode is stored in synced session data.
- Failed command output is stored with error status.
- Double-space switches remote mode back to local.
- Local switch-back resumes the same thread.
- App-server remote resumes a thread created by native Codex.
- Native Codex resumes a thread continued by app-server.
- Ambiguous id discovery fails visibly.
- No mobile app changes are needed.

Automated verification:

- Run CLI unit tests for Codex argument parsing, app-server client, protocol mapper, resume handling, and mode loop.
- Run existing Claude tests that cover local/remote assumptions to catch accidental shared regressions.
- Run typecheck for affected packages.
- Run lint/format commands required by the repo contribution guide.

Final review gate:

- Subagent review of the full diff for regressions, edge cases, and upstream review readiness.
- Human review of manual test evidence before opening any upstream PR.

## Risks

- New native session id discovery from local Codex state is not perfectly race-free.
- Codex local state file locations or schemas may change.
- App-server websocket behavior is experimental, so this PR should prefer stdio app-server for Happy remote mode unless websocket is necessary.
- Native TUI process abort may leave transient terminal state issues.
- Command output payload shape must remain compatible with current app normalization.
- Full mobile visual parity still requires a later app-renderer PR.

## Open Questions

- Should passive local-mode transcript mirroring be added later as a best-effort enhancement?
- Should Happy request an upstream Codex feature for a supported session-created event or machine-readable launch metadata?
- Should a later app PR render `CodexBash` result output using the same full-view pattern as Claude Bash?
