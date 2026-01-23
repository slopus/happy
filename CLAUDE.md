# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the Happy Coder mono-repo.

## Project Overview

Happy Coder is an AI programming assistant multi-device system mono-repo with three components:
- **happy-cli** - Command-line tool wrapping Claude Code/Gemini/Codex agents
- **expo-app** - React Native mobile/web client
- **happy-server** - End-to-end encrypted backend service

## Component Relationships

```
┌─────────────┐         ┌──────────────┐         ┌────────────┐
│  Mobile App │ ←─────→ │   Server     │ ←─────→ │     CLI    │
│  (expo-app) │         │(happy-server)│         │ (happy-cli)│
└─────────────┘         └──────────────┘         └──────┬─────┘
                                                              │
                                                       ┌──────┴─────┐
                                                       │  Daemon    │
                                                       │ (bg process)│
                                                       └────────────┘
```

**Key flows:**
- **Authentication**: CLI generates key → Server verifies → Mobile scans QR → Approves → CLI authenticated
- **Session Creation**: CLI starts session → Server stores encrypted data → Mobile views → Remote control
- **Daemon Lifecycle**: CLI starts daemon → Daemon registers machine → Server tracks state → Mobile controls

## Code Style & Development Guidelines

Shared code style principles @.claude/rules/code-style.md
Testing conventions @.claude/rules/testing.md
TypeScript rules @.claude/rules/typescript.md

## Component-Specific Guidelines

React Native guidelines @.claude/rules/react-native.md
Server development rules @.claude/rules/server.md

## Quick Reference

Component-specific documentation:
- **CLI**: @cli/CLAUDE.md - CLI commands, Agent abstraction, Daemon management
- **Daemon**: @cli/src/daemon/CLAUDE.md - Daemon lifecycle and RPC processors
- **Expo**: @expo-app/CLAUDE.md - React Native development, i18n, Unistyles
- **Server**: @server/CLAUDE.md - Fastify server, Prisma, Socket.io architecture

## Development Workflow

### Initial Setup
```bash
yarn install                           # Install dependencies (root)
cd cli && npm run setup:dev           # Setup CLI (creates ~/.happy and ~/.happy-dev)
cd server && yarn db && yarn redis    # Start local infrastructure
```

### Development Commands
```bash
# CLI (dev mode: ~/.happy-dev)
cd cli && yarn dev

# Expo app
cd expo-app && yarn start    # Start dev server
cd expo-app && yarn ios      # Run on iOS simulator

# Server (dev mode)
cd server && yarn dev        # Hot reload, kills port 3005
```

### Testing
```bash
cd cli && yarn test          # CLI tests
cd server && yarn test       # Server tests
```

## Architecture Overview

### CLI (happy-cli)
Wraps AI coding agents with universal abstraction layer. Tech: TypeScript, Node.js, Ink.

### Mobile/Web (expo-app)
Cross-platform client for remote control and viewing. Tech: React Native, Expo SDK 54, Socket.io, LiveKit.

### Server (happy-server)
Zero-knowledge backend for encrypted data sync. Tech: Fastify 5, Prisma, Socket.io, Redis.

## Environment Variables

Common: `HAPPY_SERVER_URL`, `HAPPY_WEBAPP_URL`, `HAPPY_HOME_DIR`, `HAPPY_VARIANT`
CLI: `HAPPY_DISABLE_CAFFEINATE`, `HAPPY_EXPERIMENTAL`, `GEMINI_MODEL`
Server: `PORT`, `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`

## Important Notes

1. **Always use yarn** (not npm) - All components use yarn workspaces
2. **4 spaces for indentation** - Consistent across all components
3. **TypeScript strict mode** - All components enforce strict typing
4. **End-to-end encryption** - Server cannot read user data
5. **No mocking in tests** - Integration tests make real API calls
6. **Daemon is critical** - Remote control requires daemon to be running
7. **Zero-knowledge** - Server stores encrypted data only
