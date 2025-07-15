# Happy CLI Codebase Overview

## Project Overview

Happy CLI (`handy-cli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a three-component system:

1. **handy-cli** (this project) - CLI wrapper for Claude Code
2. **handy** - React Native mobile client
3. **handy-server** - Node.js server with Prisma (hosted at https://handy-api.korshakov.org)

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Structured logging with timestamps
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption.

- **`api.ts`**: Main API client class for session management
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`auth.ts`**: Authentication flow using TweetNaCl for cryptographic signatures
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: PTY-based interactive Claude sessions
- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`watcher.ts`**: File system watcher for Claude session files
- **`types.ts`**: Claude message type definitions with parsers
- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **Authentication**: 
   - Generate/load secret key → Create signature challenge → Get auth token

2. **Session Creation**:
   - Create encrypted session with server → Establish WebSocket connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → Server
   - Remote mode: Mobile app → Server → Claude SDK → Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **End-to-end encryption**: All data encrypted before leaving the device
4. **Session persistence**: Allows resuming sessions across restarts
5. **Optimistic concurrency**: Handles distributed state updates gracefully

## Security Considerations

- Private keys stored in `~/.handy/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs

## Dependencies

- **Core**: Node.js, TypeScript
- **Claude**: `@anthropic-ai/claude-code` SDK
- **Networking**: Socket.IO client, Axios
- **Crypto**: TweetNaCl
- **Terminal**: node-pty, chalk, qrcode-terminal
- **Validation**: Zod
- **Testing**: Vitest 