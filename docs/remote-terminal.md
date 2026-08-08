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

## Protocol v3

Control plane (existing machine RPC, ack-based, encrypted):

- `terminal-create` → `success | awaiting-approval | error`
- `terminal-approve`
- `terminal-attach` →
  `{ snapshot, nextSeq, truncated, replayFrames, status, streamEpoch }`
- `terminal-list`, `terminal-get-policy`, `terminal-set-policy`
- `terminal-close`

Streaming plane (Socket.IO rooms; terminal payloads use the machine key):

- daemon → clients: encrypted `terminal:epoch`, `terminal:output`
  (`output | error` frames), `terminal:exit`, `terminal:control-ack`, and
  `terminal:control-nack`
- clients → daemon: encrypted `terminal:input`, `terminal:resize`, and
  `terminal:signal`
- writer state: `terminal:subscribe` and `terminal:takeover` acknowledgements
  return `{ writerSocketId, generation, isWriter }`; `terminal:writer`
  broadcasts synchronize other subscribers; `terminal:unsubscribe` releases
  the exact latest seat held by that socket.

Every encrypted protocol-v3 frame binds `version`, `epoch`, `terminalId`,
`machineId`, `direction`, and its applicable `streamId` inside the ciphertext.
The daemon epoch is mandatory on output, exit, error, ACK, and NACK frames.
Clients process daemon events through one inbound promise queue, so asynchronous
decryption cannot reorder Socket.IO delivery, and reject every stale-epoch
frame before it reaches the renderer or control state.

Attach returns a serialized ANSI snapshot as the authoritative barrier;
`replayFrames` only contains output pushed after the snapshot was captured, so
the renderer applies clear → snapshot → replay → live output without
duplicating state. Output is accepted only when `seq === lastSeq + 1`; a gap
starts one attach/resync operation even if several frames notice it.

The daemon sends an encrypted `epoch` announcement whenever it re-registers a
running terminal after connecting. This detects daemon-only restarts even when
the app's Socket.IO connection never dropped. A changed epoch rotates the
client control stream, resets its sequence to zero, drops pending input and
signals, retains only the latest desired terminal size, and shows one notice.
The first control accepted in the new epoch therefore uses `seq: 1`. Output,
exit, error, ACK, and NACK frames from the old epoch remain ignored.

All controls (input, resize, signal) share one ordered per-stream sequence and
one outbound queue covering sequence allocation, encryption, and emit. The
client does not allocate a sequence until attach completed and its writer
acknowledgement confirms ownership. Resize while connecting or view-only only
updates `desiredSize`; after ownership is obtained, the latest size is the
first queued control.

The daemon returns `control-ack` for every applied or duplicate control. A
`control-nack` reports `receivedSeq`, `expectedSeq`, and `gap | invalid`; the
client resends retained controls from `expectedSeq` in ascending order. A
same-epoch reconnect also resends all unacknowledged controls in ascending
order, and daemon deduplication prevents double execution. If the requested
sequence is no longer retained, the client rotates the stream, drops ambiguous
input and signals, resends the latest desired resize, and surfaces a notice
instead of remaining stuck.

## Writer lease and renderer

The server joins a subscriber to the terminal room before atomically claiming
an empty writer seat. The first subscriber becomes writer; later subscribers
are view-only. Attach and epoch resync never call takeover. Ownership changes
only after an explicit user takeover, and the acknowledgement is the requesting
client's authoritative writer state.

When ownership changes or disappears, the client disables stdin, clears pending
input and signals, rotates the control stream, and preserves only the latest
resize. Web and native xterm renderers set `disableStdin` while read-only, and
the terminal screen hides the mobile keyboard bar. The native WebView queues
`reset`, `write`, `focus`, `fit`, and `setReadOnly` operations until its `ready`
message, then drains them in order; snapshot or live output received while the
asset or WebView is loading is not discarded or injected early.

Redis stores one latest writer generation per `socketId + terminalKey`.
Repeated takeover, unsubscribe, and disconnect release that exact generation
and broadcast an empty writer state when the seat becomes vacant.

## Tmux recovery

New tmux terminals use a create-only path. Daemon restart recovery uses an
attach-existing path and never creates a replacement shell when the persisted
tmux session is gone; the record becomes `exited` instead. Snapshots target the
persisted pane ID rather than the session's currently active pane. If that pane
was closed but the session still exists, recovery selects the active pane,
persists its new pane ID, and continues.

## Security

- Payloads are encrypted end-to-end with the machine encryption key; routing
  metadata is authenticated inside the ciphertext, so the relay only sees
  opaque frames. Endpoint epoch, sequence, stream, and writer-generation checks
  reject stale, duplicate, and cross-routed frames within the cross-replica
  boundary documented below.
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
- Kill the app / toggle airplane mode → session keeps running → same-epoch
  reconnect resends pending controls in order and does not duplicate input.
- Restart only the daemon while the app socket stays connected → exactly one
  resync occurs, one notice appears, the first new control is `seq: 1`, and
  delayed output/exit/ACK frames from the old epoch are ignored.
- Two devices: first subscriber is writer, second is `View only`; attach and
  resync do not steal the seat. The viewer cannot type through xterm or the
  mobile keyboard. Explicit takeover switches ownership and sends the latest
  resize before new input.
- Repeat takeover several times, then unsubscribe or disconnect the current
  writer against Redis → its latest generation is released, viewers receive an
  empty writer broadcast, and the next subscriber can claim the seat.
- Concurrent takeovers resolve to exactly one writer (serialized in-process,
  atomic Redis Lua cross-replica). Forwarding and takeover share a per-terminal
  lock, so an old writer cannot emit after a local swap. Cross-replica
  forwarding re-checks the writer generation, but at most one stale in-flight
  frame can still slip through in multi-node deployments.
- Native: deliver snapshot, replay, and live output before the WebView reports
  ready → all content appears in clear → snapshot → replay → live order, then
  read-only changes take effect without hidden stdin events.
- Split a managed tmux session and activate another pane → attach snapshot still
  comes from the stored pane. Close the stored pane → restart adopts and
  persists the active pane. Kill the whole session → daemon restart marks the
  terminal exited and does not create a new shell.
- Close from either device kills the shell; exited state offers Reopen.
- `HAPPY_TERMINAL_ENABLED=1` on daemon: tab works. Without it: disabled notice.
- Windows daemon (no tmux): PTY fallback works; restart marks sessions exited.
- Burst output (`yes`) stays responsive; backpressure pauses the shell.

## Known boundaries (v3)

- Attaching to arbitrary existing tmux sessions is not supported yet
  (daemon-managed shells only).
- Native renderer runs xterm.js inside a WebView; a native renderer
  (e.g. Ghostty-based) can replace `TerminalView.native.tsx` without protocol
  changes.
