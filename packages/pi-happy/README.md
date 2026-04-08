# pi-happy

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that bidirectionally syncs any pi coding session with the [Happy](https://github.com/nicely-gg/happy) mobile and web app. When installed, assistant text, tool calls, thinking blocks, and turn boundaries stream in real time to the Happy app. Users can send messages from their phone into the running pi session, browse files, run terminal commands, and search code — all from their mobile device.

All communication is **end-to-end encrypted** using the same encryption pipeline as the Happy CLI.

## Prerequisites

1. **Happy CLI installed and authenticated**

   ```bash
   # Install the Happy CLI (if not already installed)
   npm install -g happy-cli

   # Log in — this creates ~/.happy/access.key
   happy login
   ```

2. **Happy daemon running** (recommended, not strictly required)

   ```bash
   happy daemon start
   ```

   The daemon tracks active sessions and enables the mobile app's session list to show your pi sessions alongside Claude and Codex sessions. Without the daemon, sessions still appear in the app once they send their first message, but session lifecycle tracking (e.g. detecting when a session ends) is less reliable.

## Installation

### Monorepo (development)

From the repository root:

```bash
pi -e ./packages/pi-happy/extensions/index.ts
```

### Future: npm package

```bash
pi install npm:pi-happy
```

## What syncs

| Direction | Content | Details |
|-----------|---------|---------|
| **pi → phone** | Assistant text | Streams in real time as the model generates output |
| **pi → phone** | Thinking blocks | Extended thinking / chain-of-thought is rendered separately |
| **pi → phone** | Tool calls | Name, arguments, start/end boundaries |
| **pi → phone** | Turn boundaries | Turn start/end with status (`completed` or `cancelled`) |
| **pi → phone** | Session lifecycle | Session creation, archival, and death signals |
| **pi → phone** | Model selection | Current model name syncs to session metadata |
| **phone → pi** | User messages | Follow-up messages when pi is idle; steering messages during streaming |

## What the phone can do

Once a pi session is active and connected to Happy, the mobile app provides:

- **Send messages** — Type a message on your phone. If pi is idle, it triggers a new turn. If pi is actively streaming, the message is delivered as a steering instruction.
- **Browse files** — Navigate the file tree on your pi machine, read file contents, and write files — all through the app's file browser.
- **Run terminal commands** — Execute shell commands on your pi machine from the app's built-in terminal.
- **Search code** — Use ripgrep-powered code search across your project (requires `rg` to be installed on your machine).
- **Kill / abort sessions** — Stop a running session or abort the current turn from the app.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPPY_SERVER_URL` | `https://api.cluster-fluster.com` | Happy API server URL |
| `HAPPY_HOME_DIR` | `~/.happy` | Happy configuration directory (credentials, settings, daemon state) |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--no-happy` | `false` | Disable the Happy sync extension entirely. Pi runs normally without any Happy integration. |

### Example

```bash
# Use a custom server
HAPPY_SERVER_URL=https://my-server.example.com pi -e ./packages/pi-happy/extensions/index.ts

# Disable Happy sync for this session
pi -e ./packages/pi-happy/extensions/index.ts --no-happy
```

## Commands

The extension registers three slash commands inside pi:

| Command | Description |
|---------|-------------|
| `/happy-status` | Show auth state, server URL, session ID, connection state, message counts, and machine ID |
| `/happy-disconnect` | Gracefully close the Happy session without clearing credentials |
| `/happy-connect` | Re-establish the Happy connection after a disconnect |

## Status indicator

The extension shows a status line in pi's footer:

| Status | Meaning |
|--------|---------|
| 📱 Happy: Connected | Socket connected, session active |
| 📱 Happy: Reconnecting... | Socket reconnecting after a drop |
| 📱 Happy: Offline (reconnecting) | Started without server access; events are dropped while offline, background reconnection in progress |
| 📱 Happy: Disconnected | Socket closed, no reconnection in progress |
| 📱 Happy: Not logged in (run 'happy login') | No credentials found at `~/.happy/access.key` |

A session widget also shows the truncated session ID, connection uptime, and message counts.

## Offline behavior

The extension handles network unavailability gracefully:

- **Startup while offline:** If the Happy server is unreachable when pi starts, the extension creates an offline stub session. Events are silently dropped (no queue buildup), and background reconnection attempts begin with exponential backoff. Once the server becomes available, a real session is created and the status transitions to "Connected".
- **Mid-session disconnect:** If the socket drops during a session, Socket.IO's built-in reconnection takes over. The status shows "Reconnecting..." and automatically recovers. Cursor-based message polling resumes with the correct `after_seq` to avoid duplicates.
- **No credentials:** If `~/.happy/access.key` doesn't exist, the extension shows "Not logged in" and does nothing. Pi operates normally without any Happy overhead.

In all cases, **Happy failures never block pi's agent loop**. Every event handler is wrapped in try/catch with a failure counter. After 10 consecutive failures, a one-time warning notification appears.

## Session switching

When you run `/new` in pi to start a fresh session:

1. The extension archives the old Happy session (sets `lifecycleState: 'archived'`, sends `session-end`)
2. A new Happy session is created with fresh metadata
3. The daemon is notified of the new session (same-PID replacement)
4. The mobile app shows the new session; the old one moves to history

This works correctly because the daemon supports same-PID session replacement — when a new session webhook arrives for a PID that already has a tracked session, the daemon updates its tracking to the new session ID.

## Session metadata

The extension populates all metadata fields that the Happy mobile app expects for correct rendering, project grouping, and machine identification:

| Field | Source |
|-------|--------|
| `path` | `ctx.cwd` — current working directory |
| `host` | `os.hostname()` |
| `version` | `pi-happy` package version |
| `os` | `os.platform()` |
| `machineId` | From `~/.happy/settings.json` |
| `homeDir` | `os.homedir()` |
| `happyHomeDir` | Resolved Happy config directory |
| `hostPid` | `process.pid` |
| `startedBy` | `'terminal'` |
| `flavor` | `'pi'` |
| `lifecycleState` | `'running'` → `'archived'` on shutdown |
| `tools` | List of registered pi tool names |
| `slashCommands` | List of registered pi command names |
| `currentModelCode` | Active model name (updated on model switch) |

> **Note:** The Happy mobile app currently renders `flavor: 'pi'` sessions with the Claude icon (unknown-flavor fallback). A future update to the Happy app will add a dedicated pi icon.

## Troubleshooting

### "Not logged in (run 'happy login')"

The extension couldn't find credentials at `~/.happy/access.key`. Run `happy login` in your terminal to authenticate with the Happy server, then restart pi.

### "Offline (reconnecting)"

The Happy server is unreachable. Check your network connection. The extension will automatically reconnect in the background. Events generated while offline are dropped — once the connection is restored, new events stream normally.

### Session not appearing in the app

1. Check that the Happy daemon is running: `happy daemon status`
2. If the daemon isn't running, start it: `happy daemon start`
3. Sessions still appear in the app without the daemon, but there may be a delay
4. Check `/happy-status` in pi for diagnostic information

### "Happy sync failing" warning

This appears after 10 consecutive event handler failures. This usually indicates a network issue or server problem. Check `/happy-status` for details. The warning appears at most once per session.

## Architecture

```
┌─────────┐     pi extension events     ┌──────────────┐
│   pi    │ ──────────────────────────→ │  Event Mapper │
│ (agent) │                             │ (PiSessionMap │
│         │ ←─── sendUserMessage() ──── │   per)        │
└─────────┘                             └──────┬───────┘
                                               │ SessionEnvelope[]
                                               ▼
                                    ┌────────────────────┐
                                    │ HappySessionClient  │
                                    │ • Session creation   │
                                    │ • Socket.IO          │
                                    │ • Encrypted messaging │
                                    │ • Keepalive           │
                                    │ • RPC handlers        │
                                    └───────┬────────────┘
                                            │ encrypted
                                            ▼
                                    ┌────────────────┐
                                    │  Happy Server   │
                                    │  (Socket.IO +   │
                                    │   HTTP API)     │
                                    └───────┬────────┘
                                            │
                                            ▼
                                    ┌────────────────┐
                                    │  Happy Mobile   │
                                    │  App            │
                                    └────────────────┘
```

### Key modules

| Module | Purpose |
|--------|---------|
| `extensions/index.ts` | Extension entry point — registers events, commands, flags |
| `extensions/event-mapper.ts` | Maps pi events to Happy `SessionEnvelope` format |
| `extensions/happy-session-client.ts` | Session lifecycle, Socket.IO, encrypted messaging |
| `extensions/offline-stub.ts` | Offline session stub with background reconnection |
| `extensions/credentials.ts` | Credential loading (legacy + dataKey formats) |
| `extensions/config.ts` | Configuration resolution from env vars |
| `extensions/settings.ts` | Machine settings from `~/.happy/settings.json` |
| `extensions/session-lifecycle.ts` | Session metadata, daemon notification, keepalive |
| `extensions/inbound-messages.ts` | Inbound message bridge (phone → pi) |
| `extensions/metadata-sync.ts` | Tool/command/model metadata sync |
| `extensions/ui.ts` | Status line, widget, and notification management |
| `extensions/commands/` | `/happy-status`, `/happy-disconnect`, `/happy-connect` |
| `vendor/` | Vendored utilities from `happy-cli` (RPC handlers, common handlers, etc.) |

### Dependencies

- **`happy-agent`** (workspace) — Encryption primitives, credential derivation
- **`@slopus/happy-wire`** (workspace) — Session protocol types, envelope creation, message schemas
- **`socket.io-client`** — Real-time communication with Happy server
- **`axios`** — HTTP API calls (session creation, message batching)
- **`tweetnacl`** — Cryptographic operations
- **`@paralleldrive/cuid2`** — ID generation for turns, tool calls
- **`zod`** — Runtime schema validation for credentials and settings

## Development

### Run tests

```bash
# All tests (unit + integration)
yarn workspace pi-happy test

# Type checking
yarn workspace pi-happy typecheck
```

### Test structure

- `extensions/__tests__/` — Unit tests for each module
- `vendor/__tests__/` and `vendor/*.test.ts` — Vendored utility tests
- `tests/integration/` — End-to-end integration tests with a mock Happy server
- `tests/mock-happy-server.ts` — Socket.IO + HTTP mock server for integration testing

### Vendored code

Some utilities are vendored from `happy-cli` because they aren't yet available as a shared package. See [`vendor/VENDORED_FROM.md`](vendor/VENDORED_FROM.md) for the full source mapping, adaptations made, and the follow-up plan to extract them into `happy-sdk`.

## Out of scope (for MVP)

- **Authentication flow** — No QR code login or `/happy-login` command. Authenticate with `happy login` before starting pi.
- **Remote session spawning** — Starting pi sessions from the mobile app (requires app changes).
- **Remote session resume** — Resuming pi sessions from the app.
- **Push notifications** — `happy_notify` tool (requires server changes).
- **Happy app modifications** — Pi sessions use existing unknown-flavor fallback rendering.
- **Permission bridge** — Pi has no permission system yet.
- **External npm distribution** — Monorepo-internal for now.

## License

See repository root for license information.
