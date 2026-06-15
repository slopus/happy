# Interactive Claude Remote Release Hardening Design

## Goal

Close the release-blocking review findings for the `design/interactive-claude-remote`
branch without expanding into unrelated dependency-audit or workspace-wide security
work.

This hardening pass covers four areas:

1. Preserve Claude auth and runtime environment when the terminal backend is tmux.
2. Use tmux only when a daemon/profile explicitly configured `TMUX_SESSION_NAME`.
3. Prevent queued prompts from being pasted into a busy Claude terminal.
4. Remove raw attachment identifiers and raw errors from new attachment upload logs.

## Non-Goals

- Do not address `pnpm audit --prod` findings in this branch.
- Do not update dependencies as part of this hardening pass.
- Do not redesign the whole interactive terminal observer.
- Do not add image/file attachment support to Claude interactive remote.
- Do not change user-facing attachment behavior except preserving the current
  unsupported/upload-failed flows with safer logs.

## Current Risks

### tmux Drops Claude Auth

`buildClaudeLocalCommand()` builds the command env from `process.env` plus profile
and daemon-provided Claude env. The PTY backend receives that env directly, but
the tmux backend currently keeps only `NO_PROXY` and `no_proxy`.

That can drop values such as `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`,
`ANTHROPIC_*`, `HAPPY_*`, and MCP/proxy settings. The result can be an auth
failure or a Claude process using the wrong local account/config.

### tmux Is Selected Too Broadly

The written interactive remote design says tmux is used when the daemon is
configured with `TMUX_SESSION_NAME` and tmux is available. The current backend
selection picks tmux whenever tmux exists. With an empty or absent session name,
tmux utilities can fall back to the first existing tmux session.

That is an operational and privacy risk because the managed Claude process may be
placed in an unexpected locally visible session.

### Input Readiness Can Be Stale

The tmux transport emits the whole visible pane capture. The terminal observer
currently treats any line that is exactly `>` or starts with `❯` as input-ready.
That can match an old prompt still visible in the pane, quoted markdown, fixtures,
or rendered diffs.

The launcher also has an input-readiness timeout that logs "sending prompt anyway"
and then pastes the queued prompt even if readiness was never observed.

### Attachment Upload Logs Leak Raw Identifiers

The app-side attachment upload path logs raw session ids, caller-controlled
attachment names, and raw error objects. This conflicts with the interactive
remote plan's privacy rule to avoid raw attachment names, refs, session ids,
paths, URLs, bytes, and raw errors.

## Design

### Terminal Backend Selection

`chooseTerminalBackend()` must treat `tmuxConfigured` as required for tmux:

```text
if tmuxConfigured and tmuxAvailable -> tmux
else if ptyAvailable -> pty
else -> unsupported
```

`createTerminalTransport()` should instantiate `TmuxTerminalTransport` only when
`env.TMUX_SESSION_NAME` is present and non-empty after trimming. It should pass
the configured value through unchanged. The transport should not synthesize a
blank session name as a way to select "first existing session".

The intended behavior is:

- `TMUX_SESSION_NAME=happy`: use tmux session `happy`.
- `TMUX_SESSION_NAME=`: treat as not configured for interactive Claude remote
  and use PTY when available.
- `TMUX_SESSION_NAME` absent: use PTY when available, even if tmux is installed.

Tests must update the current expectation that "tmux is available even without an
explicit session name" and instead prove PTY fallback.

### tmux Runtime Env Filter

The tmux backend should continue filtering environment variables before passing
them to tmux, but the allowlist must include the Claude runtime env that Happy
intentionally assembled.

Allow:

- `CLAUDE_*`
- `ANTHROPIC_*`
- `HAPPY_*`
- `MCP_*`
- `PATH`
- `HOME`
- `SHELL`
- `USER`
- `LOGNAME`
- `TMPDIR`
- `SSH_AUTH_SOCK`
- proxy variables: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, plus
  lowercase variants

Do not allow broad sensitive names such as:

- `AUTHORIZATION`
- `COOKIE`
- `PASSWORD`
- unrelated `*_TOKEN`, `*_SECRET`, or `*_KEY` values that are not in the
  allowed prefixes above

This keeps `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, profile-provided
Anthropic env, Happy reconnect/env metadata, MCP connection settings, and proxy
configuration available to the managed Claude process while avoiding a full
`process.env` dump into a long-lived tmux session.

Tests must cover both sides: Claude/Happy/proxy env survives, unrelated secrets
are removed.

### Input Readiness Gate

Readiness should be separated from general terminal diagnostics.

Add a small helper that receives the latest terminal capture and returns whether
the current terminal tail is accepting input. It should inspect only the tail of
the current capture, not every visible line. A ready prompt is valid only when it
appears in the final meaningful line or final prompt block.

It should accept the known Claude prompt forms:

- `>`
- `❯`
- `❯ Try "..."`

It should reject stale or non-prompt contexts:

- a prompt line followed by later content
- markdown quote lines such as `> quoted text`
- rendered diffs or tests that contain prompt fixtures
- terminal output that still shows thinking/progress/spinner text

The existing `classifyTerminalOutput()` can keep producing sanitized user-facing
diagnostics. The launcher should use the new readiness helper only for
`markTerminalInputReady()`.

### No Blind Paste Timeout

The launcher must not paste queued input just because the readiness wait timed
out. On timeout, it should fail the current turn with a sanitized, deterministic
message:

```text
Claude interactive terminal is not ready for input yet.
```

The runtime should stay alive unless there is a separate terminal failure. This
lets a later user retry when the terminal reaches an actual prompt.

The timeout path should:

- wake the pending wait
- avoid `transport.paste()`
- close the current Claude session turn as failed
- leave terminal metadata in an interactive/degraded state with the same safe
  message, rather than crashing the process

### Attachment Upload Logging

`uploadAttachmentsForSession()` should keep current behavior:

- no blob key: skip all attachments
- per-attachment upload/read/encrypt failure: skip that attachment and continue
- user-facing upload failure alert remains count-based

Logs must be privacy-safe:

- no raw `sessionId`
- no raw attachment name
- no URI/path
- no upload ref
- no bytes/base64/decrypted content
- no raw `Error` object or stack

Allowed log fields:

- phase (`missing_blob_key`, `upload_failed`)
- attachment count or index
- attachment size and dimensions when already available as metadata
- `errorName` from the thrown value, bounded to a short string

The helper can live locally in `sync.ts` or in a small attachment logging helper
if that keeps tests clearer. Do not import the older diagnostics model unless it
is already present in this branch.

## Data Flow

### Launch

```text
daemon/profile env
  -> buildClaudeLocalCommand()
  -> TerminalSpawnOptions.env
  -> PTY env directly, or tmux env allowlist
  -> real `claude` process
```

### Prompt Injection

```text
queued Happy prompt
  -> validateInteractiveBatch()
  -> waitForTerminalInputReady()
  -> latest terminal tail is ready
  -> paste into terminal
```

If readiness times out:

```text
queued Happy prompt
  -> waitForTerminalInputReady()
  -> timeout without ready prompt
  -> close turn failed
  -> no terminal paste
```

### Attachment Upload

```text
attachment preview
  -> read/encrypt/upload
  -> success: file event queued
  -> failure: safe log + count-based user alert
```

## Error Handling

- Missing or empty tmux configuration is not an error. It selects PTY when
  available.
- tmux unavailable with explicit non-empty `TMUX_SESSION_NAME` falls back to PTY,
  matching the backend order from the original design.
- Env filtering must not log env values.
- Readiness timeout is a failed turn, not a terminal crash.
- Terminal auth/process errors continue to use sanitized terminal diagnostics.
- Attachment upload failures remain non-fatal to the text send path when the
  current behavior permits text to continue.

## Testing

Add or update targeted tests:

- `terminalTransport.test.ts`
  - tmux is chosen only when `tmuxConfigured` and available
  - PTY is chosen when tmux is available but not configured
  - PTY is chosen when `TMUX_SESSION_NAME` is an empty string
  - tmux env filter keeps Claude/Anthropic/Happy/MCP/proxy env
  - tmux env filter drops unrelated cookie/password/authorization/token/key
    values
- `terminalObserver.test.ts` or a new readiness-helper test file
  - accepts only tail prompt forms
  - rejects stale prompt lines followed by later output
  - rejects markdown quote/diff/fixture prompt text
  - rejects prompt-looking output while spinner/progress text is visible at tail
- `claudeInteractiveRemoteLauncher.test.ts`
  - readiness timeout does not call `transport.paste()`
  - readiness timeout closes the current turn as failed with the safe message
  - a later actual ready signal can still allow a subsequent prompt
- app-side attachment test
  - attachment upload failure logs do not include raw session id, attachment
    name, URI/path, upload ref, or raw error text
  - failed uploads still increment the failed count and continue existing user
    behavior

Run the existing verification set after implementation:

```text
git diff --check
pnpm --filter happy exec vitest run --project unit
pnpm --dir packages/happy-app test sources/sync/attachmentSupport.test.ts --run
pnpm --filter happy run typecheck
pnpm --filter happy-app run typecheck
```

When possible, add a manual smoke before release:

- Claude remote with PTY fallback and valid auth
- Claude remote with `TMUX_SESSION_NAME` set and valid auth
- local attach/switch for tmux still works
- queued prompt is not pasted while Claude is busy

## Release Bar

This branch can be considered release-ready for interactive Claude remote only
after:

- findings 1 through 4 are fixed
- targeted tests cover the changed contracts
- typecheck and relevant unit tests pass
- a real Claude auth smoke covers at least PTY or tmux, and tmux smoke is run
  before any release that advertises local attach
