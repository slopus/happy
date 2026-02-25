# Happy Dev — Voice/STT Fix Project

This checkout is a development fork of [Happy Coder](https://github.com/slopus/happy.git) focused on fixing the voice / speech-to-text feature.

## What We're Doing

The Happy app's voice feature (ElevenLabs Conversational AI integration) is broken. We're diagnosing and fixing it. The voice system uses ElevenLabs (NOT Whisper/traditional STT) for bidirectional real-time voice via WebRTC.

## Project Structure

Yarn v1 monorepo with 5 packages:
- `packages/happy-app` — Expo SDK 54 React Native app (iOS, Android, web). Voice code lives here.
- `packages/happy-cli` — CLI wrapper for Claude Code / Codex
- `packages/happy-agent` — Remote agent control CLI
- `packages/happy-server` — Fastify backend (Postgres, Redis, MinIO, Socket.io)
- `packages/happy-wire` — Shared wire protocol types

## Voice Architecture (the thing we're fixing)

Flow: User taps mic → microphone permission → fetch ElevenLabs token from server → WebRTC session via ElevenLabs SDK → bidirectional audio streaming.

Key files:
- `packages/happy-app/sources/realtime/RealtimeSession.ts` — Entry point, orchestrates voice start/stop
- `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx` — Web implementation (ElevenLabs `useConversation` hook)
- `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx` — Native mobile implementation
- `packages/happy-app/sources/realtime/voiceConfig.ts` — Config flags (debug logging, tool calls, history limits)
- `packages/happy-app/sources/realtime/hooks/voiceHooks.ts` — Context updates sent to voice assistant
- `packages/happy-app/sources/realtime/realtimeClientTools.ts` — Tools the voice assistant can invoke
- `packages/happy-app/sources/sync/apiVoice.ts` — Client-side token fetch
- `packages/happy-app/sources/utils/microphonePermissions.ts` — Mic permission handling
- `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` — Server endpoint for ElevenLabs token

Config / env vars:
- `ELEVENLABS_API_KEY` — Server-side, required for token minting
- `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV` / `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD` — Agent IDs
- `experiments` setting in app — toggles auth flow (off = no token needed, on = full RevenueCat + token flow)

## Local Infrastructure

We have a self-hosted Happy relay server on erying-0 (`happy-relay.seas.house`, 10.23.7.9). It runs nginx + happy-server + postgres + redis + minio in Docker. See `~/mission-control/docs/happy-relay-runbook.md` for details.

For dev work, we develop here on WSL (kat-desktop-host). If we need new infra (boxes, networking, SSL, reverse proxy), drop a markdown request file in `~/mission-control/` and ask Mission Control to provision it.

## Commands

### From monorepo root
- `yarn cli` — Run the CLI from source
- `yarn web` — Run the web app

### From packages/happy-app
- `yarn start` — Expo dev server
- `yarn web` — Web browser dev
- `yarn typecheck` — TypeScript check (run after all changes)

### From packages/happy-server
- `yarn start` — Start server
- `yarn build` — TypeScript check
- `yarn test` — Run tests
- `yarn db` — Start local Postgres in Docker
- `yarn migrate` — Run Prisma migrations

## Development Guidelines

- Use **4 spaces** for indentation
- Use **yarn** (not npm)
- Path alias `@/*` maps to `./sources/*` in happy-app and happy-server
- Run `yarn typecheck` in happy-app after changes
- Never use React Native's `Alert` module — use `@/modal` instead
- Always use `t(...)` from `@/text` for user-visible strings
- See `packages/happy-app/CLAUDE.md` and `packages/happy-server/CLAUDE.md` for package-specific rules

## Vector Search

This codebase has local vector search available. Use it to navigate the large codebase efficiently — search for concepts, patterns, and related code across packages.
