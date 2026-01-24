# Happy Coder - Development Guidelines

This document provides guidance to AI coding agents when working with code in this repository.

---

## Project Overview

**Happy Coder** is a mobile and web client for Claude Code and Codex that enables remote control with end-to-end encryption. The project is a monorepo with three main components:

| Component | Path | Description |
|-----------|------|-------------|
| **CLI** | `/cli` | Command-line tool that wraps Claude Code/Codex |
| **Server** | `/server` | Backend server for encrypted sync (Fastify + Prisma) |
| **App** | `/expo-app` | Mobile/Web/Desktop client (Expo + React Native + Tauri) |

---

## Quick Start Commands

### CLI (`/cli`)
```bash
yarn install
yarn dev              # Development mode
yarn build            # Build for production
yarn test             # Run tests
```

### Server (`/server`)
```bash
yarn install
yarn dev              # Start development server
yarn build            # TypeScript type checking
yarn test             # Run tests
yarn db               # Start local PostgreSQL in Docker
yarn generate         # Generate Prisma client
```

### App (`/expo-app`)
```bash
yarn install
yarn start            # Start Expo development server
yarn ios              # Run on iOS simulator
yarn android          # Run on Android emulator
yarn web              # Run in web browser
yarn tauri:dev        # Run macOS desktop app
yarn typecheck        # Run TypeScript type checking
yarn test             # Run tests
```

---

## Code Style

### TypeScript Conventions
- **Strict typing**: No `any` types, no `@ts-ignore`
- **Functional patterns**: Avoid classes, prefer functions
- **Named exports**: Preferred over default exports
- **Import aliases**: Use `@/` for src imports

### Indentation
- **CLI & Server**: 4 spaces
- **App**: 4 spaces

### Naming
- Use descriptive names with auxiliary verbs: `isLoading`, `hasError`
- Prefer single-word names where possible

### Error Handling
- Graceful error handling with proper messages
- Use `try-catch` with specific error logging
- App: Never show loading errors, always retry

---

## Component-Specific Guidelines

### CLI Guidelines
- All debugging through file logs (avoid disturbing Claude sessions)
- Console output only for user-facing messages
- **NEVER import modules mid-code** - ALL imports at top of file
- Tests make real API calls (no mocking)

### Server Guidelines
- Use `inTx` for database transactions
- Use `afterTx` for event emission after transaction commits
- Design all operations to be idempotent
- Use `yarn generate` after schema changes (never create migrations manually)
- Always use `@/` prefix for imports
- Use `privacyKit.decodeBase64` and `privacyKit.encodeBase64` from privacy-kit

### App Guidelines
- Always use `t(...)` function for ALL user-visible strings (i18n)
- When adding new strings, add to ALL language files in `sources/text/translations/`
- Use `StyleSheet.create` from `react-native-unistyles` for styling
- Never use `Alert` module - use `@sources/modal/index.ts` instead
- Always run `yarn typecheck` after changes
- Use `useHappyAction` for async operations
- Wrap pages in `memo`
- Use `expo-router` API, not `react-navigation`

---

## Architecture Notes

### Communication Flow
1. **Authentication**: QR code-based with challenge-response
2. **Session Creation**: Encrypted with tag-based deduplication
3. **Message Flow**:
   - Interactive: User → PTY → Claude → File watcher → Server
   - Remote: Mobile → Server → Claude SDK → Server → Mobile

### Security
- End-to-end encryption using TweetNaCl/libsodium
- Private keys stored with restricted permissions
- Challenge-response authentication

---

## Testing

- **Framework**: Vitest for all components
- **CLI/Server**: Test files with `.spec.ts` suffix
- **App**: Test files with `.test.ts` suffix
- Write tests BEFORE implementation for utility functions

---

## Important Reminders

1. Do what has been asked; nothing more, nothing less
2. NEVER create files unless absolutely necessary
3. ALWAYS prefer editing existing files over creating new ones
4. NEVER proactively create documentation files unless requested
5. Always verify changes with appropriate type checking commands
