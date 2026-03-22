# @slopus/happy-sync

Sync protocol types, SyncNode, and encryption for Happy.

This package is the single shared sync primitive imported by CLI, daemon, app, and tests. It contains:
- v3 protocol types (Zod schemas for `MessageWithParts`, `Part`, `ToolState`, `Block`, `SessionInfo`, etc.)
- `SyncNode` class — connection, encrypt, send, receive, state management
- Encryption utilities (encrypt/decrypt message content)

## Development Commands

```bash
# from repository root
yarn workspace @slopus/happy-sync build
yarn workspace @slopus/happy-sync test
```
