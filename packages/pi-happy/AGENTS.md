# pi-happy — LLM Guidance

This extension syncs pi coding agent sessions to the Happy mobile and web app.

## What this extension does

- **Outbound (pi → phone):** Every pi event — assistant text deltas, thinking blocks, tool call start/end, turn boundaries, session lifecycle — is translated into Happy's `SessionEnvelope` protocol format, encrypted, and sent to the Happy server via Socket.IO and HTTP batch API. The Happy mobile app renders these in real time.

- **Inbound (phone → pi):** When a user types a message in the Happy mobile app, it arrives as an encrypted `UserMessage`. The extension decrypts it and routes it into pi:
  - If pi is **idle** (`ctx.isIdle()` returns true): the message triggers a new turn via `pi.sendUserMessage(text)`
  - If pi is **streaming** (not idle): the message is delivered as a steering instruction via `pi.sendUserMessage(text, { deliverAs: "steer" })`

- **RPC handlers:** The extension registers session-scoped RPC handlers that let the mobile app interact with the pi machine: `bash` (run commands), `readFile`, `writeFile`, `listDirectory`, `getDirectoryTree`, `ripgrep` (code search), `killSession`, and `abort`.

## Key design decisions

- **Happy failures never block pi.** Every event handler is wrapped in try/catch. Errors are logged with `[pi-happy]` prefix and counted. After 10 consecutive failures, a one-time warning notification appears. The agent loop continues uninterrupted.

- **Offline-first.** If the Happy server is unreachable at startup, the extension creates an offline stub and begins background reconnection with exponential backoff. Pi operates normally throughout.

- **End-to-end encryption.** All messages are encrypted before leaving the process using either legacy (secret-key) or dataKey (public-key) encryption, matching the Happy CLI's encryption pipeline.

- **Session switching.** When the user runs `/new` in pi, the extension archives the old Happy session and creates a new one. The daemon's same-PID tracking is updated so the app correctly shows the new session.

## File layout

```
extensions/
  index.ts              — Extension entry point, event registration, command/flag setup
  event-mapper.ts       — PiSessionMapper: translates pi events → SessionEnvelope[]
  happy-session-client.ts — Session creation, Socket.IO, encrypted messaging, keepalive
  offline-stub.ts       — OfflineHappySessionStub for startup-while-offline
  credentials.ts        — Load and parse ~/.happy/access.key (legacy + dataKey formats)
  config.ts             — Resolve config from env vars (HAPPY_SERVER_URL, HAPPY_HOME_DIR)
  settings.ts           — Read machineId from ~/.happy/settings.json
  session-lifecycle.ts  — Build metadata, notify daemon, keepalive loop
  inbound-messages.ts   — Bridge inbound mobile messages into pi
  metadata-sync.ts      — Sync tool/command/model metadata to Happy session
  ui.ts                 — ConnectionUIManager: status line, widget, notifications
  types.ts              — Shared type definitions and interfaces
  commands/
    status.ts           — /happy-status command handler
    connect.ts          — /happy-connect and /happy-disconnect command handlers
vendor/
  register-common-handlers.ts — File browser, terminal, search RPC handlers
  rpc/handler-manager.ts      — RPC handler registration and dispatch
  async-lock.ts, invalidate-sync.ts, time.ts, path-security.ts, logger.ts
```

## Important patterns

- The `PiSessionMapper` accumulates text deltas and flushes on type transitions (thinking ↔ output) or before tool call boundaries. This matches the `AcpSessionManager` pattern from `happy-cli`.
- The `HappySessionClient` uses `InvalidateSync` for both send and receive paths — coalescing rapid updates into batched operations.
- Metadata updates use `AsyncLock` + `backoff` with version-conflict resolution matching `ApiSessionClient`.
- The extension uses workspace dependencies on `happy-agent` (encryption, credentials) and `@slopus/happy-wire` (protocol types, schemas) rather than vendoring from `happy-cli`.

## When modifying this code

- Keep the "never block pi" invariant — all Happy-related code must be inside try/catch in event handlers.
- Test with both credential formats (legacy `{ token, secret }` and dataKey `{ token, encryption: { publicKey, machineKey } }`).
- Run `yarn workspace pi-happy test` to verify all unit and integration tests pass.
- The mock Happy server in `tests/mock-happy-server.ts` simulates the full server API for integration testing.
