# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For shared development principles and mono-repo overview, see [CLAUDE.md](../CLAUDE.md)**

## Component Overview

Happy CLI (`happy-cli`) - Command-line tool wrapping AI coding agents (Claude Code, Gemini CLI, Codex) with remote control and session sharing capabilities.

## Common Development Commands

### Building & Testing

```bash
# Type checking
yarn typecheck          # Run TypeScript compiler check

# Build
yarn build              # Full build: typecheck + pkgroll
yarn test               # Build and run all tests

# Development
yarn dev                # Run without building (uses tsx)
yarn dev:local-server   # Run with local server (HAPPY_SERVER_URL=http://localhost:3005)
yarn dev:integration-test-env  # Run with integration test environment

# Create global happy-dev command for local testing
yarn link:dev           # Create symlink: ~/.npm-global/bin/happy-dev -> dist/
yarn unlink:dev         # Remove symlink
```

### Running Tests

```bash
yarn test               # Run all tests (builds first)
yarn build && vitest run  # Run tests without rebuilding
vitest run src/path/to/test.test.ts  # Run specific test file
vitest run -t "test name"  # Run tests matching pattern
```

### Stable vs Development Mode

The CLI supports running stable and development versions side-by-side with isolated data:

```bash
# Initial setup (creates ~/.happy and ~/.happy-dev directories)
npm run setup:dev

# Stable mode (production, data: ~/.happy)
npm run stable:daemon:start
npm run stable auth login
npm run stable notify "test"

# Dev mode (testing, data: ~/.happy-dev)
npm run dev:daemon:start
npm run dev:variant auth login
npm run dev:variant notify "test"
```

### Daemon Management

```bash
# Start daemon (background service for remote control)
./bin/happy.mjs daemon start
yarn dev:daemon:start   # Dev mode
yarn stable:daemon:start  # Stable mode

# Check status
./bin/happy.mjs daemon status

# Stop daemon
./bin/happy.mjs daemon stop

# View logs (stored in ~/.happy-dev/logs/ or ~/.happy/logs/)
tail -f ~/.happy-dev/logs/*.log
```

### Doctor & Troubleshooting

```bash
# System diagnostics
./bin/happy.mjs doctor

# Clean up runaway processes
./bin/happy.mjs doctor clean
```

## CLI-Specific Code Style

### TypeScript Conventions
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities
- **Export style**: Named exports preferred, with occasional default exports for main functions

### Error Handling
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

For shared code style guidelines, see @../.claude/rules/code-style.md
For testing guidelines, see @../.claude/rules/testing.md
For TypeScript rules, see @../.claude/rules/typescript.md

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption using WebSocket (Socket.IO) and REST. Key files: `apiSession.ts` for real-time communication, `apiMachine.ts` for daemon registration, and `encryption.ts` for TweetNaCl-based end-to-end encryption.

### 2. Agent Module (`/src/agent/`)
Universal agent abstraction layer. `Agent` interface provides generic abstraction over AI coding agents (Claude, Gemini, Codex). `Transport` interface abstracts communication methods (stdio, HTTP, WebSocket). Adapters in `adapters/` translate backend-specific protocols to the generic interface.

### 3. Claude Integration (`/src/claude/`)
Claude Code integration using `@anthropic-ai/claude-code` SDK. Entry point: `runClaude.ts`. Handles session persistence, permission modes (auto/default/plan).

### 4. Gemini Integration (`/src/gemini/`)
Gemini CLI integration via stdio transport. Entry point: `runGemini.ts`.

### 5. Codex Integration (`/src/codex/`)
OpenAI/Codex integration using Agent Client Protocol. Entry point: `runCodex.ts`.

### 6. Daemon (`/src/daemon/`)
Background service for remote control and session management. Key file: `run.ts` handles daemon lifecycle (start, heartbeat, shutdown, version mismatch detection). **For detailed daemon architecture, state machine, and RPC processors, see [CLAUDE.md](./src/daemon/CLAUDE.md)**

### 7. Other Components
- **`/src/commands/`**: CLI command handlers (auth, connect)
- **`/src/modules/`**: Pluggable tools (proxy, file watcher, ripgrep, difftastic)
- **`/src/ui/`**: Terminal UI components using Ink
- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings, keys, profiles

## Data Flow

### 1. Authentication
```
Generate/load secret key → Create signature challenge → Get auth token
```
- Uses TweetNaCl for cryptographic signatures
- Private key stored in `~/.happy/access.key` (or `~/.happy-dev/access.key` for dev)
- Challenge-response authentication prevents replay attacks

### 2. Daemon Startup
```
CLI → spawn detached process → startDaemon()
  → Version check (stop old if mismatch)
  → Lock acquisition
  → Auth check
  → HTTP server start (random port)
  → WebSocket connection to backend
  → RPC registration
  → Heartbeat loop (60s)
```

### 3. Session Creation

**Terminal-spawned:**
```
User runs `happy`
  → Auto-start daemon if needed
  → Create session with backend
  → Notify daemon via /session-started webhook
  → Daemon tracks session
```

**Daemon-spawned (remote):**
```
Mobile app → Backend → RPC spawn-happy-session
  → Daemon spawns detached Happy process
  → Happy creates session, calls /session-started
  → Daemon updates tracking, RPC returns to mobile
```

### 4. Message Flow

**Claude SDK mode:**
```
User input → Agent → SDK → Agent responses → Server → Mobile app
```

**Gemini/Codex mode:**
```
User input → Agent → stdio transport → CLI process → Agent responses → Server → Mobile app
```

### 5. Profile Sync Flow
```
GUI creates profile → Backend syncs to daemon
  → Daemon receives via WebSocket
  → Stores in settings.json
  → Applied when spawning sessions
```

## Key Design Decisions

1. **File-based logging**: Prevents interference with agent terminal UIs
2. **Agent abstraction**: Generic interface supports multiple AI backends
3. **Transport abstraction**: Separates communication method from agent logic
4. **End-to-end encryption**: All data encrypted before leaving the device
5. **Session persistence**: Allows resuming sessions across restarts
6. **Optimistic concurrency**: Handles distributed state updates gracefully
7. **Stable/Dev isolation**: Separate data directories for side-by-side testing

## Security Considerations

- Private keys stored in `~/.happy/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs
- HTTP control server listens on 127.0.0.1 only (localhost)

## Environment Variables

### Configuration
- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.cluster-fluster.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)
- `HAPPY_VARIANT` - Variant mode: 'stable' or 'dev' (affects HAPPY_HOME_DIR)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to 'true', '1', or 'yes')
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to 'true', '1', or 'yes')
- `HAPPY_DAEMON_HEARTBEAT_INTERVAL` - Daemon heartbeat interval in seconds (default: 60)

### AI Backend Configuration
- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Session Forking and --resume Behavior

When using `--resume` flag with Claude:
1. Creates a **NEW** session file with a **NEW** session ID
2. Original session file remains unchanged
3. New session file contains **complete history** from original session
4. All historical messages have their `sessionId` field **updated** to the new session ID
5. Context is fully preserved - Claude maintains full conversational context

**Implications:**
- Session ID in stream-json output will be the new one, not the resumed one
- Original session remains as historical record
- All context preserved but under new session identity

## Data Directories

Stable mode uses `~/.happy/`, dev mode uses `~/.happy-dev/` (set via `HAPPY_VARIANT` or `HAPPY_HOME_DIR`). Each contains `settings.json`, `access.key`, `daemon.state.json`, and `logs/`. Claude Code data is in `~/.claude/`.