# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Happy Coder is a mobile and web client for Claude Code & Codex with end-to-end encryption. It lets users control AI coding agents from mobile devices while all data stays encrypted.

## Monorepo Structure

Yarn 1.22 workspaces monorepo with five packages:

| Package | Purpose | Published As |
|---------|---------|-------------|
| `happy-app` | React Native (Expo 54) mobile/web/desktop UI | iOS/Android/Web/Tauri |
| `happy-cli` | CLI wrapper for Claude Code | `happy-coder` on npm |
| `happy-server` | Fastify 5 backend with Prisma/PostgreSQL | Deployed server |
| `happy-wire` | Shared Zod wire protocol schemas | `@slopus/happy-wire` |
| `happy-agent` | Remote agent control CLI | `@slopus/agent` |

## Commands

### Root Level
```bash
yarn cli --help          # Run CLI from source
yarn web                 # Run happy-app in web browser
yarn release             # Interactive release for all packages
```

### Per-Package (use `yarn workspace <name> <script>`)
```bash
# happy-app
yarn workspace happy-app start       # Expo dev server
yarn workspace happy-app web         # Web version
yarn workspace happy-app ios         # iOS simulator
yarn workspace happy-app test        # Vitest
yarn workspace happy-app typecheck   # TypeScript check

# happy-cli
yarn workspace happy-coder dev       # Run with tsx (no build)
yarn workspace happy-coder test      # Build + Vitest
yarn workspace happy-coder build     # Compile with pkgroll

# happy-server
yarn workspace happy-server dev      # Dev server with hot reload (port 3005)
yarn workspace happy-server test     # Vitest
yarn workspace happy-server migrate  # Prisma migrations
yarn workspace happy-server db       # Docker PostgreSQL
yarn workspace happy-server redis    # Docker Redis

# happy-wire
yarn workspace @slopus/happy-wire build
yarn workspace @slopus/happy-wire test
```

### Running a Single Test
All packages use Vitest. Run a specific test file:
```bash
yarn workspace happy-coder test src/path/to/file.test.ts
yarn workspace happy-server test sources/path/to/file.spec.ts
```

## Code Style (All Packages)

- **4 spaces** for indentation
- **yarn** only (never npm)
- **Strict TypeScript** everywhere
- **`@/` import alias** maps to `src/` or `sources/` depending on package
- All imports at top of file, absolute imports preferred
- Named exports preferred
- Functional programming patterns; avoid classes
- No enums; use maps
- Interfaces over types (happy-server convention)

## Architecture

### Data Flow
1. **CLI** (`happy`) wraps Claude Code, creates encrypted sessions with the server
2. **Server** stores only encrypted blobs it cannot decrypt (zero-knowledge)
3. **App** (mobile/web) connects via Socket.IO, decrypts locally, provides remote control
4. **Wire** package defines shared Zod schemas for the protocol between all components

### Authentication
QR code-based with TweetNaCl cryptographic signatures. No passwords. Public key crypto only.

### Encryption
End-to-end using libsodium (app) and TweetNaCl (CLI). Server never sees plaintext. Per-session encryption with key derivation. Both metadata and state are encrypted separately with optimistic concurrency versioning.

### Real-time Communication
Socket.IO with Redis pub/sub for scaling (optional in-memory fallback). WebSocket events for session updates, machine state, and RPC calls between mobile and daemon.

### Daemon
The CLI runs a background daemon process that maintains persistent WebSocket connection to server, manages session lifecycles, handles auto-updates on version changes, and exposes a local HTTP control server on 127.0.0.1.

## Package-Specific Guidelines

Each package has its own `CLAUDE.md` with detailed guidelines. Key highlights:

### happy-app
- Expo Router v6 (file-based routing) - always use expo-router API, not react-navigation
- Unistyles for styling (use `StyleSheet.create` from `react-native-unistyles`)
- **i18n is mandatory**: all user-visible strings must use `t()` from `@/text`, added to all 9 languages
- Use `Modal` from `@/modal` instead of React Native `Alert`
- Use `useHappyAction` for async operations with automatic error handling
- App pages go in `@sources/app/(app)/`
- Wrap pages in `memo`, put styles at end of file
- Never use Unistyles for expo-image; use classical styles
- No backward compatibility unless explicitly requested

### happy-cli
- File-based logging (never console output during Claude sessions)
- Dual mode: interactive (terminal PTY) and remote (SDK via mobile)
- Test files colocated as `.test.ts`
- No mocking in tests

### happy-server
- Fastify 5 with Zod validation on all routes
- Prisma ORM - **never create migrations yourself** (only `yarn generate` for types)
- Use `inTx` for database transactions; don't run non-transactional operations inside transactions
- Event bus (Redis or in-memory) with `afterTx` for post-commit events
- Action files named as `entityAction` (e.g., `friendAdd.ts`)
- All operations must be idempotent
- Test files use `.spec.ts` suffix
- Use `privacyKit.decodeBase64`/`encodeBase64` instead of Buffer

## Testing

- **Framework**: Vitest in all packages
- **No mocking** - tests make real calls
- **Test location**: colocated with source (`.test.ts` for CLI/wire, `.spec.ts` for server)
- **Server tests**: write tests before implementation for utility functions
