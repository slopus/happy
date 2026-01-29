# Happy Docs

This folder documents how Happy works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Start here.

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries and on-wire encoding.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- cli-architecture.md: Planned. CLI and daemon architecture and how they interact with the server.

## Conventions
- Paths and field names reflect the current implementation in `packages/happy-server`.
- Examples are illustrative; the canonical source is the code.
