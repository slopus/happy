# Remote Persistent Terminals

Happy can expose the **real terminal of a connected machine** as a first-class
entity: a persistent shell (PTY) owned by the daemon, streamed to the mobile
app and web client over the same end-to-end-encrypted relay used for agent
sessions.

This is an escape hatch for terminal-heavy workflows — the agent UI stays the
primary surface, but when you need `git`, `pnpm`, `docker`, `ssh`, `vim`, or a
long-running dev server, the shell is right there in your pocket.

## Rollout status

**Experimental / staged rollout.** The daemon feature is off by default and
opt-in per machine:

```bash
HAPPY_TERMINAL_ENABLED=1 happy daemon start
```

When the daemon has the flag off, the machine screen shows "Terminals are
disabled on this machine" instead of failing silently.

## Architecture

```
Happy app (mobile / web)
        │  control RPC (machine-scoped, E2EE)
        │  streaming frames (encrypted, seq-ordered)
        ▼
Happy server ── relay only ── rooms + writer lock, never sees content
        │
        ▼
Happy daemon ── TerminalManager
        ├── PtyShellSession   (node-pty + headless xterm snapshots)
        └── TmuxShellSession  (tmux control mode, restart-persistent)
```

Terminals are daemon-owned entities with a persisted registry
(`terminals.json` under the Happy home dir). tmux-backed shells survive daemon
restarts (`happy-term-<id>` sessions); plain PTY shells survive while the
daemon runs and are marked `exited` after a restart.

## Protocol

Control plane (existing machine RPC, ack-based, encrypted):

- `terminal-create` → `success | awaiting-approval | error`
- `terminal-approve`
- `terminal-attach` → `{ snapshot, nextSeq, truncated, replayFrames, status }`
- `terminal-list`, `terminal-get-policy`, `terminal-set-policy`
- `terminal-close`

Streaming plane (Socket.IO rooms, payloads encrypted with the machine key):

- daemon → clients: `terminal:output`, `terminal:exit`, `terminal:input-ack`
- clients → daemon: `terminal:input`, `terminal:resize`, `terminal:signal`
- writer seat: `terminal:subscribe` / `terminal:unsubscribe` /
  `terminal:takeover`; exactly one writer per terminal, everyone else
  view-only until takeover.

Every encrypted frame binds `version`, `terminalId`, `machineId`, `streamId`,
and `direction` inside the ciphertext, so a relay cannot cross-route or replay
a frame. Attach returns a serialized ANSI snapshot plus buffered frames after
`lastSeq`; clients subscribe before attaching, buffer live frames during the
snapshot RPC, and apply them against the attach barrier. Output is only
accepted when `seq === lastSeq + 1`; any gap triggers a resync.

Input is idempotent per writer stream: the daemon tracks
`lastProcessedSeqByStream` and re-acks duplicate frames without executing them,
so a command re-sent after a lost ACK never runs twice. Unacknowledged input is
re-sent in order after reconnect.

## Security

- Payloads are encrypted end-to-end with the machine encryption key; routing
  metadata is authenticated inside the ciphertext, so the relay only routes
  opaque frames and cannot replay or misroute them.
- Opening a shell is approval-gated. Policy (per session by default, configurable
  to once-per-machine or none) is enforced daemon-side before spawn.
- Terminal IDs and payload sizes are validated server-side; rooms are scoped by
  authenticated user.
- A remote shell is remote code execution on the machine — treat the phone as
  a trusted, unlocked boundary, same as the desktop.

## Platform matrix

| Platform | Shell backend | Persistence |
| --- | --- | --- |
| macOS / Linux | tmux control mode (preferred) | Survives daemon restarts |
| macOS / Linux / Windows | node-pty fallback (ConPTY on Windows) | Survives while daemon runs |

## Manual QA checklist

- Create terminal → approval modal → shell appears with snapshot and live output.
- `vim`, `htop`, `lazygit`, and full-screen TUI apps restore correctly after reconnect.
- Kill the app / toggle airplane mode → session keeps running → reopen shows
  reconnected state with no duplicated input.
- Two devices: first is writer, second is view-only; takeover switches the writer.
  Concurrent takeovers resolve to exactly one writer (serialized in-process,
  atomic Redis Lua cross-replica).
- Close from either device kills the shell; exited state offers Reopen.
- `HAPPY_TERMINAL_ENABLED=1` on daemon: tab works. Without it: disabled notice.
- Windows daemon (no tmux): PTY fallback works; restart marks sessions exited.
- Burst output (`yes`) stays responsive; backpressure pauses the shell.

## Known boundaries (v1)

- Attaching to arbitrary existing tmux sessions is not supported yet
  (daemon-managed shells only).
- Native renderer runs xterm.js inside a WebView; a native renderer
  (e.g. Ghostty-based) can replace `TerminalView.native.tsx` without protocol
  changes.
