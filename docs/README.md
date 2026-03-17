# Happy Next Docs

This folder documents how Happy Next works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Start here.

## Index
- [protocol.md](protocol.md): Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- [api.md](api.md): HTTP endpoints and authentication flows.
- [encryption.md](encryption.md): Encryption boundaries and on-wire encoding.
- [backend-architecture.md](backend-architecture.md): Internal backend structure, data flow, and key subsystems.
- [deployment.md](deployment.md): How to deploy the backend and required infrastructure.
- [self-host.md](self-host.md): Self-hosting with the root docker-compose stack.
- [cli-architecture.md](cli-architecture.md): CLI and daemon architecture and how they interact with the server.
- [orchestrator.md](orchestrator.md): Multi-task orchestration — usage scenarios, MCP tools, DAG dependencies, retry, and multi-machine dispatch.
- [changes-from-happy.md](changes-from-happy.md): What changed in Happy Next vs the original Happy (`main` branch).

## Conventions
- Paths and field names reflect the current implementation in `packages/happy-server`.
- Examples are illustrative; the canonical source is the code.
