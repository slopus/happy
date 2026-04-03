# Happy Docs

This folder documents how Happy works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Start here.

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries and on-wire encoding.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- dev-environments.md: Local `environments/data/` workflow, lab-rat project provisioning, `env:cli` passthrough behavior, and daemon usage.
- session-protocol.md: Unified encrypted chat event protocol.
- session-protocol-claude.md: Claude-specific session-protocol flow (local vs remote launchers, dedupe/restarts).
- plans/provider-envelope-redesign.md: Proposed replacement for the current provider/session envelope design.
- permission-resolution.md: State-based permission mode resolution across app and CLI (including sandbox behavior).
- happy-wire.md: Shared wire schemas/types package and migration notes.
- voice-architecture.md: ElevenLabs voice assistant integration, session routing, context batching, and VAD detection.
- research/: general research notes and exploratory writeups.
- competition/: competitor research, protocol analysis, and comparison notes.
- competition/AGENTS.md: structure and rules for storing competitor research results without committing raw checkouts.

## Conventions
- Paths and field names reflect the current implementation in `packages/happy-server`.
- Examples are illustrative; the canonical source is the code.
