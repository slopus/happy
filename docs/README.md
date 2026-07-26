# Paws Documentation

This folder documents Paws: the app, CLI, self-host server, protocols, deployment, and current product direction. Paws is independently maintained; the retained GitHub fork relationship is historical attribution, not an upstream-sync commitment.

Internal package names and compatibility identifiers still use `happy-*` in many places. Keep those exact names when they refer to code, environment variables, storage paths, wire packages, or the `happy` CLI alias. Historical plans, research, and architecture records may also retain the original Happy name so that links and implementation history stay traceable.

## Index
- `getting-started.md`: English onboarding for users, self-hosters, and contributors.
- `getting-started.zh-CN.md`: Chinese onboarding for users, self-hosters, and contributors.
- `selfhost-web-deploy.md`: English manual for building, securing, deploying, updating, and rolling back the Web App.
- `selfhost-web-deploy.zh-CN.md`: Chinese manual for building, securing, deploying, updating, and rolling back the Web App.
- `CONTRIBUTING.md`: Paws repository workflow, worktrees, checks, and pull requests.
- `roadmap.md`: Current shipped foundations and prioritized work.
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- realtime-sync-and-rpc.md: High-level overview of realtime socket management and RPC control flow.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries and on-wire encoding.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- selfhost-intranet-deploy.md: Self-hosting the server and clients on an intranet.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- multi-process.md: Deeper multi-replica Socket.IO + Redis streams behavior, failure modes, and integration-test history.
- dev-environments.md: Local `environments/data/` workflow, lab-rat project provisioning, `env:cli` passthrough behavior, and daemon usage.
- session-protocol.md: Unified encrypted chat event protocol.
- session-protocol-claude.md: Claude-specific session-protocol flow (local vs remote launchers, dedupe/restarts).
- plans/provider-envelope-redesign.md: Proposed replacement for the current provider/session envelope design.
- permission-resolution.md: State-based permission mode resolution across app and CLI (including sandbox behavior).
- happy-wire.md: Shared wire schemas/types package and migration notes.
- voice-architecture.md: ElevenLabs voice assistant integration, session routing, context batching, and VAD detection.
- research/: general research notes and exploratory writeups.
- research/2026-07-04-right-swipe-panel-retrospective.md: Retrospective and checklist for mirrored mobile gesture work, based on the right swipe panel rollout.
- competition/: competitor research, protocol analysis, and comparison notes.
- competition/AGENTS.md: structure and rules for storing competitor research results without committing raw checkouts.

## Conventions
- Product-facing prose uses **Paws**.
- Paths, package names, environment variables, storage directories, and protocol fields use their exact implementation names, even when they contain `happy` or `HANDY`.
- `plans/`, `research/`, `experimental/`, and `competition/` are historical or exploratory records; do not treat every statement in them as current product behavior.
- Examples are illustrative. Current package manifests, `packages/happy-app/app.config.js`, workflows, and source code are canonical.
