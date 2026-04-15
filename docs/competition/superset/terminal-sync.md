# Superset Terminal State Sync

Deep dive completed 2026-04-08 from `github.com/superset-sh/superset`.

## Two architectures

Superset has **two coexisting terminal architectures**:

- **V1 (desktop daemon)** — mature path for local terminals
- **V2 (host-service WebSocket)** — simpler path for remote/cloud workspaces

```
V1 (local):
  PTY subprocess ──[5-byte frame protocol]──> Daemon process
      ──[Unix domain socket, NDJSON]──> Electron main
      ──[Electron IPC, tRPC subscriptions]──> Renderer ──> xterm.js

V2 (remote):
  PTY (node-pty) ──[direct]──> Host-service process
      ──[WebSocket, JSON messages]──> Renderer ──> xterm.js
```

Both stream data in real-time — no polling.

## V1: Desktop daemon path

### Data flow

1. PTY runs in a **separate child process** (`pty-subprocess.js`),
   isolating blocking PTY I/O from Electron's event loop.

2. Subprocess sends framed binary messages via **stdout** using a custom
   frame protocol — 5-byte header (1 byte type + 4 byte length):
   ```
   Frame types: Ready, Spawned, Data, Exit, Error,
                Spawn, Write, Resize, Kill, Signal, Dispose
   ```

3. `Session` class decodes frames and broadcasts to attached clients via
   **Unix domain sockets** (`~/.superset/terminal-host.sock`) using NDJSON.
   Auth via shared token from `terminal-host.token`.

4. `TerminalHostClient` maintains **two sockets** per daemon:
   - `controlSocket` — request/response RPC
   - `streamSocket` — unidirectional event streaming

5. Electron main process relays events to renderer via **tRPC subscriptions**
   over Electron IPC.

### HeadlessEmulator (the clever bit)

A headless xterm instance (`@xterm/headless` + `@xterm/addon-serialize`)
runs in the daemon, mirroring all PTY output. Tracks:

- Full screen state with 5000-line scrollback
- 14 terminal mode flags (DECSET/DECRST)
- CWD (via OSC-7)
- Alternate screen buffer state

On re-attach, produces a `TerminalSnapshot`:
```
{
  snapshotAnsi,         // serialized screen via @xterm/addon-serialize
  rehydrateSequences,   // mode-restoring escape sequences
  modes,                // 14 tracked terminal mode flags
  cwd,                  // last known working directory
  dimensions            // cols × rows
}
```

This enables faithful restoration of TUI apps (vim, htop) including
alternate screen buffer, bracketed paste mode, mouse tracking, etc.

### Backpressure

- Tracks per-client socket drain state
- Pauses PTY stdout reads when emulator write queue exceeds **1MB**
  (`EMULATOR_WRITE_QUEUE_HIGH_WATERMARK_BYTES`)
- Resumes at **250KB**
- Subprocess stdin has a **2MB** queue cap

## V2: Host-service WebSocket path

### Data flow

1. PTY spawned directly via `node-pty.spawn()` in host-service process.

2. Output streamed via WebSocket at `/terminal/:terminalId`. JSON messages:
   ```
   Server → Client:  { type: "data"|"replay"|"error"|"exit", data: "..." }
   Client → Server:  { type: "input"|"resize"|"dispose", ... }
   ```

3. WebSocket upgraded via `@hono/node-ws` in the Hono HTTP server.

### PTY lifetime is independent of WebSocket lifetime

Explicit design: "PTY lifetime is independent of socket lifetime — sockets
detach/reattach freely."

- When WebSocket disconnects, PTY keeps running
- Output buffered in **64KB in-memory ring buffer** (`MAX_BUFFER_BYTES`)
- On reconnect, `replayBuffer()` sends all buffered output as a single
  `{ type: "replay", data: "..." }` message
- Auto-reconnect: exponential backoff (500ms base, 10s max, 10 attempts)

### Terminal session lifecycle

`terminalSessions` table in host-service SQLite:
```sql
terminal_sessions (
  id TEXT PRIMARY KEY,
  origin_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | exited | disposed
  created_at INTEGER NOT NULL,
  last_attached_at INTEGER,
  ended_at INTEGER
)
```

Lifecycle:
1. **Create**: `POST /terminal/sessions` or first WebSocket to
   `/terminal/:terminalId`. Spawns PTY, inserts row, adds to in-memory Map.
2. **Attach/detach**: WebSocket open/close. Multiple connections to same
   terminal displaces old socket (close code 4000). Updates `lastAttachedAt`.
3. **Exit**: PTY `onExit` → `status: 'exited'`, sets `endedAt`.
4. **Dispose**: `DELETE /terminal/sessions/:terminalId` or `{ type: "dispose" }`
   message. Kills PTY, removes from Map, `status: 'disposed'`.
5. **List**: `GET /terminal/sessions` returns live sessions with `terminalId`,
   `exited`, `exitCode`, `attached` status.

## Multi-pane management

Each terminal is identified by a `terminalId`. The panes system
(`@superset/panes`) is a Zustand store with a **binary tree layout model**.

```
Tab
  └── layout: LayoutNode (binary tree of splits)
  └── panes: Record<string, Pane>
        └── kind: "terminal"
        └── data: { terminalId: "..." }
```

**`TerminalRuntimeRegistry`** — singleton managing per-terminal entries:
- Each entry contains a `TerminalRuntime` (xterm instance + addons) and
  a `TerminalTransport` (WebSocket connection)
- Keyed by `terminalId`
- Pane mount → `registry.attach(terminalId, container, wsUrl, appearance)`
- Pane unmount → `registry.detach(terminalId)`

**Runtime persists independently of the DOM.** On detach, xterm buffer is
serialized to `localStorage` (up to 1000 lines). On re-attach, restored
from localStorage and DOM wrapper re-appended. Multiple panes have
completely independent terminals, WebSockets, and xterm instances.

## Scrollback preservation — 5 layers

| Layer | Location | Size | Purpose |
|-------|----------|------|---------|
| xterm.js scrollback | Renderer | 5000 lines | Live buffer in the UI |
| HeadlessEmulator | V1 daemon | 5000 lines | Authoritative source for session restoration |
| Ring buffer | V2 host-service | 64KB | Captures output while no WebSocket connected |
| localStorage | Renderer | 1000 lines | Survives pane detach/re-mount |
| Cold restore snapshot | V1 daemon | Full screen | Restores TUI apps with escape sequences |

**Cold restore** (after daemon/app restart): scrollback shown as read-only
with a "Session Contents Restored" separator. User can start a new shell
in the same CWD. Handled by `useTerminalColdRestore` hook.

## Key files

- `apps/desktop/src/main/terminal-host/session.ts` — V1 session management
- `apps/desktop/src/main/lib/terminal-host/client.ts` — V1 daemon client
- `apps/desktop/src/main/lib/terminal-host/headless-emulator.ts` — HeadlessEmulator
- `packages/host-service/src/terminal/terminal.ts` — V2 terminal lifecycle
- `packages/host-service/src/db/schema.ts` — terminalSessions table
- `apps/desktop/src/renderer/lib/terminal/terminal-runtime-registry.ts` — runtime registry
- `apps/desktop/src/renderer/lib/terminal/terminal-ws-transport.ts` — V2 WebSocket transport
- `packages/panes/src/core/store/store.ts` — pane layout store

## Happy takeaways

- The V1 subprocess isolation pattern (PTY in child process, frame protocol
  over stdout) is worth considering if Happy ever runs PTY directly — keeps
  the main process responsive.
- HeadlessEmulator for faithful TUI restoration is clever — `@xterm/headless`
  + `@xterm/addon-serialize` enables restoring vim/htop state including
  alternate screen buffer and terminal modes.
- The 64KB ring buffer for reconnection replay (V2) is a simple, effective
  pattern — no complex journaling, just buffer recent output and replay on
  reconnect.
- PTY lifetime decoupled from UI lifetime is the right design — matches
  how Happy's daemon already works.
- localStorage for renderer-side scrollback persistence across pane
  remounts is a cheap win.
