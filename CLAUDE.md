# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Runline** (internally "Runline Arc") is a fork of [Happy](https://github.com/slopus/happy) — a mobile interface for AI agents running on Claude Code. The core philosophy: **Agent identity lives in the repo, not the app.** The mobile app is a viewing layer that connects to running agents, not a container for AI logic.

- **User-facing name**: Runline
- **Internal project name**: Runline Arc
- **Repo name**: arc (under Runline-AI GitHub org)

### Fork Relationship

Runline is largely dependent on core Happy functionality for session management, relay communication, and base UI. We extend the platform with Runline-specific features:
- **Agents** — `.arc.yaml` config for agent identity, display, and voice binding
- **Organization structure** — Enterprise team and agent management (planned)
- **SOPs** — Standard operating procedures for agent workflows (planned)
- **Platform-aware capabilities** — Features beyond Happy's scope

All Runline customizations live in `expo-app/sources/arc/` to minimize merge conflicts when syncing upstream.

## Monorepo Structure

```
arc/
├── cli/          # Happy CLI wrapper for Claude Code
├── expo-app/     # Mobile app (React Native + Expo SDK 54)
├── server/       # Happy relay server (Fastify + PostgreSQL)
└── docs/         # Arc documentation
```

**Key principle:** Never modify Happy files. All Arc customization goes in `expo-app/sources/arc/`. Use `patch-package` if Happy files must be changed.

## Common Commands

### expo-app (Mobile)
```bash
yarn install          # Install all workspace dependencies (run from root)
cd expo-app
yarn ios              # Run on iOS simulator
yarn android          # Run on Android emulator
yarn start            # Start Expo dev server
yarn typecheck        # TypeScript type checking (run after all changes)
yarn test             # Run tests (Vitest)
yarn ota              # Deploy OTA update to preview
yarn ota:production   # Deploy OTA update to production
```

### cli
```bash
cd cli
yarn build            # Compile TypeScript
yarn test             # Run tests
./bin/happy.mjs daemon start   # Start daemon
./bin/happy.mjs daemon stop    # Stop daemon
```

### server
```bash
cd server
yarn db               # Start PostgreSQL in Docker
yarn start            # Start server
yarn test             # Run tests
yarn generate         # Generate Prisma client (never run migrations yourself)
```

## Architecture

### Agent Config System
Agents configure display via `.arc.yaml` in their repository:
```yaml
agent:
  name: "Emila"
  tagline: "Executive assistant"
  avatar: generated

voice:
  elevenlabs_agent_id: "agent-id"
```

The mobile app loads this via RPC from Claude Code sessions (3s timeout, then fallback to defaults). Config code lives in `expo-app/sources/arc/agent/`.

### Real-time Communication
- WebSocket-based sync with automatic reconnection
- End-to-end encryption using libsodium (mobile) / TweetNaCl (CLI)
- Session state managed through `SyncSocket` and `SyncSession` classes

### Authentication
- QR code challenge-response using cryptographic signatures
- Keys stored in `~/.handy/access.key` (CLI) or secure storage (mobile)

## Workspace-Specific Guidelines

Each workspace has detailed CLAUDE.md with specific patterns:
- `expo-app/CLAUDE.md` — Styling (Unistyles), i18n, component patterns
- `cli/CLAUDE.md` — Session handling, Claude SDK integration
- `server/CLAUDE.md` — Database patterns, debugging commands

## Critical Patterns

### expo-app
- Use `t()` for ALL user-visible strings; add to all 9 language files
- Use `Modal` from `@/modal` instead of React Native's `Alert`
- Use `useHappyAction` for async operations with automatic error handling
- Use `ItemList` for list containers, `Avatar` for avatars
- Always run `yarn typecheck` after changes
- 4-space indentation
- Wrap pages in `memo`
- Styles at end of file

### cli
- All imports at top of file, use `@/` prefix
- File-based logging only (avoid console to not disturb Claude sessions)
- No mocking in tests — make real API calls

### server
- Functional patterns, avoid classes
- Use `inTx` for database transactions
- Use `afterTx` to emit events after transaction commits
- Test files use `.spec.ts` suffix
- Never create migrations yourself

## Syncing Upstream

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should be minimal since Arc code is isolated in `sources/arc/`.

## Branding & Logo Assets

When updating Runline branding, these are the key locations:

### SVG Components (Primary - edit these first)
| File | Purpose |
|------|---------|
| `expo-app/sources/components/RunlineLogo.tsx` | Full "RUNLINE" wordmark (welcome screen) |
| `expo-app/sources/components/RunlineIcon.tsx` | "R" icon (header, small contexts) |

### App Name in Translations
Update `sessionsTitle` in all files:
- `expo-app/sources/text/_default.ts`
- `expo-app/sources/text/translations/*.ts` (9 language files)

### Image Assets (may still reference Happy branding)
| File | Purpose | Status |
|------|---------|--------|
| `icon.png` | App icon | Needs Runline version |
| `icon-adaptive.png` | Android adaptive icon | Needs Runline version |
| `icon-monochrome.png` | Android monochrome | Needs Runline version |
| `icon-notification.png` | Push notification icon | Needs Runline version |
| `favicon.png` | Web favicon | Needs Runline version |
| `favicon-active.png` | Web favicon (active) | Needs Runline version |
| `splash-android-*.png` | Android splash screens | Needs Runline version |
| `logo-black.png`, `logo-white.png` | Legacy Happy logos | Deprecated, use RunlineIcon |
| `logotype-*.png` | Legacy Happy wordmarks | Deprecated, use RunlineLogo |

### App Configuration
| File | Fields |
|------|--------|
| `expo-app/app.config.js` | `name`, `slug`, `scheme` |

### Code References
Search for these patterns when doing a full rebrand:
```bash
grep -r "Happy" expo-app/sources/ --include="*.ts" --include="*.tsx"
grep -r "happy" expo-app/sources/ --include="*.ts" --include="*.tsx"
```

## Known Issues

### libsodium-wrappers web build (metro.config.js)
The ESM build of libsodium-wrappers 0.7.16+ uses top-level await which Metro doesn't support. We have a custom resolver in `expo-app/metro.config.js` that forces the CommonJS version on web. Upstream Happy pins to 0.7.14 which doesn't have this issue. Revisit if libsodium-wrappers fixes ESM compatibility.
