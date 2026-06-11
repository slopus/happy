# Interactive Claude Remote Design

## Goal

Replace Claude remote mode's SDK-based execution path with a real interactive
Claude CLI session controlled through PTY or tmux.

Happy should let users continue using their normal Claude Code subscription
surface from mobile/web by remotely controlling a real `claude` terminal
session on their own machine. The remote experience must not use
`@anthropic-ai/claude-agent-sdk`, `claude -p`, API keys, or a silent SDK
fallback.

## Background

Happy already has most of the primitives needed for an interactive remote
runtime:

- `claudeLocal` starts the real interactive Claude CLI and wires in Happy's
  system prompt, MCP config, allowed tools, hook settings, and sandbox wrapper.
- `claudeLocalLauncher` watches Claude JSONL through `sessionScanner` and sends
  transcript records through the existing Claude session protocol mapper.
- `claudeRemote` currently uses the Claude Agent SDK query stream for app-driven
  remote execution.
- `runClaude` already tracks `local` and `remote` ownership, has a remote-mode
  JSONL scanner for terminal-side prompts, and starts the Happy MCP server plus
  Claude hook server.
- The daemon can spawn Happy sessions inside tmux when `TMUX_SESSION_NAME` is
  configured.
- `docs/competition/superset/terminal-sync.md` documents a proven PTY pattern:
  PTY lifetime independent of UI lifetime, reconnect replay buffers,
  terminal-state snapshots, and optional subprocess isolation.

The design uses those existing parts, but changes the Claude remote runtime's
source of truth from SDK stream events to an interactive process.

## Non-Goals

- Do not spoof Claude Desktop, Claude first-party headers, environment markers,
  or client identity.
- Do not use `@anthropic-ai/claude-agent-sdk` as an automatic fallback.
- Do not use `claude -p` or any headless Claude path for the primary remote
  runtime.
- Do not require users to provide Anthropic API keys.
- Do not build a full mobile terminal emulator for the first release.
- Do not replace Happy's existing session protocol mapper.

## Product Behavior

Starting a Claude remote session from Happy creates or reuses a real interactive
Claude CLI process in a managed terminal. The user sees the same Happy chat UI,
but behind it Happy sends prompts to the terminal and observes Claude through
transcript files, hooks, and a small terminal stream.

The UI should expose the runtime class explicitly:

- `interactive`: real Claude CLI is running and accepting remote input.
- `starting`: terminal is being created and Claude session id is not known yet.
- `degraded`: Claude is running, but a non-critical observer is missing.
- `unsupported`: the machine cannot run interactive remote mode.
- `failed`: the process exited or a required observer failed.

If interactive remote cannot start, Happy must show a clear error and stop. It
must not fall back to SDK execution.

## Architecture

Add a new Claude runtime:

```text
Mobile/Web app
  -> Happy sync/server
  -> local daemon/CLI
  -> InteractiveClaudeSessionManager
  -> TerminalTransport
  -> PTY or tmux pane
  -> real `claude` CLI

real `claude` CLI
  -> JSONL transcript + hooks + terminal stream
  -> TranscriptObserver / HookObserver / TerminalObserver
  -> existing session protocol mapper
  -> Mobile/Web app
```

The implementation should keep the runtime boundary narrow. The new runtime is
responsible for terminal lifecycle and prompt injection. Existing code remains
responsible for session sync, encryption, protocol mapping, file attachments,
and app rendering.

### Runtime Selection

Claude remote mode uses only the interactive runtime.

```text
agent = claude
startingMode = remote
  -> claudeInteractiveRemoteLauncher
```

The old SDK launcher may remain in the repository during migration, but product
code must not select it as a fallback for Claude remote. If retained for
development, it must require an explicit internal flag and must identify itself
as SDK mode in metadata.

### Terminal Backend Order

Use this backend order:

1. tmux pane, when the daemon is configured with `TMUX_SESSION_NAME` and tmux is
   available.
2. direct PTY subprocess, when tmux is unavailable but the platform can allocate
   a PTY.
3. unsupported, when neither backend is available.

tmux is preferred for daemon-spawned sessions because users can attach locally
and inspect the real process. Direct PTY is necessary for environments without
tmux and for eventual cross-platform support.

## Components

### InteractiveClaudeSessionManager

Owns the lifecycle of one interactive Claude remote session.

Responsibilities:

- create or attach to a terminal backend
- build the same Claude command shape used by local mode
- pass hook settings, MCP config, sandbox config, allowed tools, and Claude args
- bind Happy session id, Claude session id, terminal id, and process id
- expose `sendPrompt`, `interrupt`, `resize`, `stop`, and `dispose`
- publish runtime state into session metadata

The manager does not parse Claude chat content. It delegates structured
transcript parsing to `TranscriptObserver`.

### TerminalTransport

Small abstraction over tmux and direct PTY operations.

Required operations:

- spawn command in cwd with env
- write bytes to stdin
- send Enter, Escape, and Ctrl-C
- resize terminal
- stream recent stdout/stderr bytes
- report exit code and signal
- dispose terminal resources

The first release should keep the terminal stream as operational telemetry, not
as the primary chat source. The transcript remains the primary chat source.

### TranscriptObserver

Watches Claude JSONL files with the existing scanner and forwards records into
`sendClaudeSessionMessage`.

Responsibilities:

- wait for the Claude session id from hooks or transcript discovery
- seed existing transcript lines as processed on attach/resume
- forward new assistant, user, and tool records
- dedupe app-sent prompts that later appear in JSONL
- close turns based on process and transcript state

This should reuse `sessionScanner` and `sessionProtocolMapper` rather than
adding a second Claude transcript parser.

### HookObserver

Uses the existing hook server and generated hook settings file.

Required signals:

- `SessionStart` to bind the Claude session id
- permission or lifecycle events when available
- process/session end hints when available

If hooks cannot be installed, the runtime should not pretend it is fully
healthy. For the first release, missing hooks make session start fail unless
transcript discovery can prove the session id and file path within a bounded
timeout.

### TerminalObserver

Reads terminal output to fill gaps not present in JSONL:

- Claude has rendered a permission prompt
- Claude is waiting at the input prompt
- Claude printed a usage limit or auth error
- Claude is showing a spinner but has not written transcript records yet
- terminal process produced an unrecoverable error

TerminalObserver should use conservative pattern matching and should not try to
reconstruct assistant messages from terminal text.

## Data Flows

### New Remote Session

```text
App requests Claude session in directory
  -> daemon spawns Happy CLI in remote mode
  -> InteractiveClaudeSessionManager creates terminal
  -> terminal starts real `claude`
  -> HookObserver receives SessionStart
  -> TranscriptObserver starts watching JSONL
  -> runtime metadata becomes interactive/running
```

### App Prompt

```text
App sends user message
  -> runClaude queue receives message and mode metadata
  -> InteractiveClaudeSessionManager formats terminal input
  -> TerminalTransport writes prompt + Enter
  -> Claude writes JSONL records
  -> TranscriptObserver forwards records
  -> existing protocol mapper updates Happy chat
```

Prompt formatting must preserve normal Claude interactive behavior. The first
version should send plain text plus Enter. It should not use headless JSON
message injection.

### Switch To Local Control

When a user wants desktop control, Happy should leave the same interactive
Claude process alive and mark the session as locally controlled. If the process
is in tmux, the app can show attach instructions. If the process is direct PTY,
local handoff is limited until a terminal attach surface exists.

Switching back to remote should not restart Claude when the existing terminal is
healthy. It should reattach observers and resume sending input to the same
terminal.

### Resume And Fork

Resume must use normal interactive Claude flags:

- `--resume <claude-session-id>` when the target Claude session id is known
- `--continue` only when Happy intentionally wants Claude to choose the latest
  session for the cwd

Fork/duplicate should keep using Claude JSONL copy/truncate mechanics, then
start a real interactive `claude --resume <new-id>` terminal. Historical
backfill remains a Happy responsibility because Claude will not replay old
messages to the UI.

## Failure Handling

Interactive remote mode should fail closed.

| Condition | State | Behavior |
|---|---|---|
| Claude CLI not found | unsupported | show update/install guidance |
| tmux unavailable and PTY unavailable | unsupported | no SDK fallback |
| hook settings rejected | failed | stop; user must fix hook/settings issue |
| hooks unavailable but transcript discovery succeeds | degraded | continue with reduced lifecycle visibility |
| transcript file not found in timeout | failed | show transcript unavailable error |
| terminal write fails | failed | stop accepting app prompts |
| Claude exits with non-zero code | failed | surface exit code and recent terminal output |
| Claude usage/auth error appears | failed | surface user-actionable message |
| app disconnects | interactive | terminal keeps running |
| daemon exits | unknown | next daemon start attempts adoption if manifest exists |

All failures must be visible in metadata and app UI. No path should silently
switch to SDK execution.

## Security And Compliance

This design intentionally controls a user-owned interactive process. It does
not attempt to impersonate Claude Desktop or bypass Anthropic client
classification.

Security requirements:

- keep terminal logs out of normal application logs unless debug mode is enabled
- redact auth tokens and environment variable values
- do not upload raw terminal streams as chat messages
- keep existing end-to-end encryption for Happy message sync
- preserve sandbox behavior from local Claude mode
- avoid logging attachment names, paths, or decrypted bytes beyond existing
  privacy-safe patterns

## Migration

The migration should be explicit:

- New CLI version advertises `interactive-remote` support.
- App detects whether a machine supports interactive remote mode.
- Claude remote sessions on unsupported machines show an upgrade or unsupported
  message.
- Existing local sessions continue working.
- Existing SDK remote code is not selected automatically for Claude.

Recommended rollout order:

1. Add metadata and capability detection.
2. Add terminal backend abstraction and tests.
3. Add interactive Claude remote launcher behind a feature flag.
4. Make Claude remote select interactive runtime only.
5. Remove or quarantine SDK remote entrypoints for Claude.
6. Ship user-facing update nudge before the June 15, 2026 billing split date.

## Testing

Unit tests:

- runtime selection never picks SDK for Claude remote
- terminal backend selection prefers configured tmux, then PTY, then unsupported
- prompt writer sends plain text plus Enter
- interrupt sends Ctrl-C
- transcript observer dedupes app prompts that appear in JSONL
- missing transcript timeout transitions to failed
- process exit transitions to failed with exit code

Integration tests:

- fake PTY process writes a Claude-like JSONL transcript and Happy forwards it
- fake hook server binds a Claude session id before transcript watching starts
- app prompt reaches PTY stdin and produces one user message in Happy
- daemon-spawned tmux session reports a tracked process id and Happy session id
- reconnect reattaches observers without replaying old JSONL lines

Manual verification:

- start `happy claude --happy-starting-mode remote`
- send a prompt from mobile/web
- verify real `claude` process is running interactively
- verify no Agent SDK query path is invoked
- approve/deny a permission request
- interrupt a running request
- switch to local control and back
- resume an existing Claude session
- kill the app connection and confirm Claude keeps running

## Open Questions

- Should direct PTY be supported in the first implementation, or should first
  release require tmux on Unix-like systems?
- How much terminal output should the app show during degraded states?
- Which Claude permission prompts are reliably exposed through hooks today, and
  which require terminal pattern detection?
- Should Happy create a durable terminal manifest for adoption after daemon
  restart, or rely on tmux for first release durability?
- What is the minimum supported Windows story: no support, ConPTY, or WSL/tmux?

## Acceptance Criteria

- Claude remote mode runs a real interactive `claude` process.
- App prompts are delivered through terminal stdin.
- Chat state comes from Claude JSONL plus existing Happy protocol mapping.
- Hooks bind the Claude session id or startup fails with a clear error.
- The runtime never falls back to `@anthropic-ai/claude-agent-sdk`.
- Unsupported machines show an unsupported state instead of starting SDK mode.
- The design preserves local foreground Claude behavior.
