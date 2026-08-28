# Contributing to Happy Coder

Thanks for your interest in contributing! Happy Coder is an open-source project and we welcome contributions of all kinds.

## Prerequisites

- **Node.js** 20 or later
- **Yarn** 1.22.22 (the repo enforces this exact version)
- **Git**

For specific packages you may also need:

| Package | Extra Requirements |
|---------|-------------------|
| happy-server | PostgreSQL, Redis, S3-compatible storage (MinIO) |
| happy-app (iOS) | Xcode, CocoaPods |
| happy-app (Android) | Android SDK |
| happy-app (macOS) | Rust toolchain (for Tauri desktop build) |

## Getting Started

```bash
# Clone the repo
git clone https://github.com/slopus/happy.git
cd happy

# Install dependencies (uses Yarn workspaces)
yarn install

# Run the CLI in dev mode
yarn cli --help

# Run the web app
yarn web
```

## Project Structure

This is a Yarn workspaces monorepo with 5 packages:

| Package | Description | Published |
|---------|-------------|-----------|
| **happy-cli** | CLI wrapper for Claude Code and Codex | `happy-coder` on npm |
| **happy-server** | Fastify backend (Prisma + PostgreSQL + Redis) | Private |
| **happy-app** | React Native + Expo mobile/web client | Private |
| **happy-agent** | Remote agent control CLI | `@slopus/agent` on npm |
| **happy-wire** | Shared Zod schemas and wire types | `@slopus/happy-wire` on npm |

## Development Commands

### Root level

```bash
yarn cli             # Run happy-cli in dev mode (via tsx)
yarn cli codex       # Run in Codex mode
yarn web             # Start happy-app web dev server
yarn release         # Interactive release (maintainers only)
```

### Per-package commands

Run these with `yarn workspace <package-name> <script>`:

**happy-cli** (`happy-coder`)
```bash
yarn workspace happy-coder dev          # Dev mode with tsx
yarn workspace happy-coder build        # Build with pkgroll
yarn workspace happy-coder test         # Build + vitest
yarn workspace happy-coder typecheck    # tsc --noEmit
```

**happy-server**
```bash
yarn workspace happy-server dev         # Dev server with tsx
yarn workspace happy-server build       # Typecheck
yarn workspace happy-server test        # vitest
yarn workspace happy-server db          # Start PostgreSQL (Docker)
yarn workspace happy-server redis       # Start Redis (Docker)
yarn workspace happy-server s3          # Start MinIO (Docker)
yarn workspace happy-server migrate     # Run Prisma migrations
```

**happy-app**
```bash
yarn workspace happy-app start          # Expo dev server
yarn workspace happy-app web            # Web dev server
yarn workspace happy-app ios            # iOS simulator
yarn workspace happy-app android        # Android emulator
yarn workspace happy-app typecheck      # tsc --noEmit
yarn workspace happy-app test           # vitest
yarn workspace happy-app tauri:dev      # macOS desktop (Tauri)
```

**happy-wire** (`@slopus/happy-wire`)
```bash
yarn workspace @slopus/happy-wire build      # Build with pkgroll
yarn workspace @slopus/happy-wire test       # Build + vitest
yarn workspace @slopus/happy-wire typecheck  # tsc --noEmit
```

**happy-agent** (`@slopus/agent`)
```bash
yarn workspace @slopus/agent build      # Build with pkgroll
yarn workspace @slopus/agent test       # Build + vitest
yarn workspace @slopus/agent dev        # Dev mode with tsx
```

## Code Conventions

### All packages

- **TypeScript strict mode** — `strict: true` in all tsconfigs
- **ESM** — All packages use `"type": "module"`
- **Path alias** — Use `@/` for src imports (e.g., `import { logger } from '@/ui/logger'`)
- **4-space indentation**
- **Named exports** preferred over default exports
- **All imports at the top** of the file — never import mid-code

### happy-cli specific

- **No mocking in tests** — Tests make real API calls
- **File-based logging** — Use the logger, not `console.log`, to avoid interfering with Claude's terminal UI
- **JSDoc headers** — Each file should have a header comment explaining its responsibilities
- **Minimal classes** — Prefer functions over classes

### happy-server specific

- **Functional style** — Avoid classes where possible
- **Interfaces over types** — Use `interface` for object shapes
- **No enums** — Use plain objects/maps instead
- **Prisma** for all database access

### happy-app specific

- **Unistyles** for styling (not StyleSheet)
- **Expo Router** for navigation (not React Navigation directly)
- **i18n** — All user-visible strings must use the `t()` function
  - Translations live in `sources/text/translations/`
  - Supported languages: en, ru, pl, es, ca, it, pt, ja, zh-Hans

## Testing

All packages use **Vitest**. Test files are colocated with source files using the `*.test.ts` naming convention.

```bash
# Run tests for a specific package
yarn workspace happy-coder test
yarn workspace happy-server test
yarn workspace happy-app test

# Or from the package directory
cd packages/happy-cli && npx vitest run
```

Key testing principles:
- No mocking — tests should make real calls where possible
- Test files live alongside source files (not in a separate `__tests__` directory)

## CI

Pull requests are automatically checked by GitHub Actions:

- **CLI smoke test** — Runs `happy --help`, `happy --version`, `happy doctor`, and `happy daemon status` on Linux and Windows with Node 20 and 24
- **Typecheck** — Runs `yarn workspace happy-app typecheck` on Ubuntu with Node 20

## Submitting Changes

1. **Fork** the repo and create a branch from `main`
2. **Make your changes** — follow the code conventions above
3. **Test** — run the relevant package tests before submitting
4. **Open a PR** — describe what you changed and why

For questions or discussion, join the [Discord](https://discord.gg/fX9WBAhyfD).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENCE).
