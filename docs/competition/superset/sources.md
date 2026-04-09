# Superset Sources

Reviewed on 2026-04-08.

- repo: `https://github.com/superset-sh/superset`
- site: `https://superset.sh`
- stars: 9,092 (as of 2026-04-08)
- license: Elastic License 2.0 (ELv2)
- current version: desktop-v1.4.7

## Key files inspected

- `apps/desktop/src/main/lib/host-service-manager.ts` — host-service spawn, manifest, adopt
- `apps/desktop/src/main/host-service/index.ts` — host-service Electron integration
- `apps/electric-proxy/src/electric.ts` — Electric SQL proxy worker
- `packages/host-service/src/events/event-bus.ts` — WebSocket event bus
- `packages/host-service/src/events/git-watcher.ts` — git change detection
- `packages/host-service/src/trpc/router/workspace/workspace.ts` — workspace/worktree management
- `packages/workspace-client/src/lib/eventBus.ts` — client-side event bus
- `packages/local-db/src/schema/schema.ts` — local SQLite schema with synced tables
- `packages/db/src/schema/` — cloud Postgres schema
- `packages/shared/src/agent-command.ts` — agent launch command builder
- `packages/shared/src/builtin-terminal-agents.ts` — agent type definitions
- `packages/panes/src/store.ts` — binary-tree pane layout engine
- `packages/mcp/src/tools/` — MCP tools for remote control
- `packages/cli/src/` — CLI command structure
- `apps/desktop/src/main/lib/agent-setup/` — agent hook injection
- `apps/desktop/src/main/lib/host-service-manifest.ts` — manifest format and I/O
- `apps/desktop/src/renderer/routes/_authenticated/providers/CollectionsProvider/collections.ts` — Electric SQL consumer, 22 shape subscriptions
- `apps/desktop/src/renderer/routes/_authenticated/components/AgentHooks/hooks/useCommandWatcher/useCommandWatcher.ts` — command queue executor
- `apps/electric-proxy/src/index.ts` — Cloudflare Worker auth + proxy
- `packages/host-service/src/db/schema.ts` — host-service SQLite schema
- `packages/db/src/schema/auth.ts` — auth schema
- `packages/db/src/schema/github.ts` — GitHub schema
- `packages/trpc/src/router/agent/agent.ts` — agent command tRPC router

## Research files in this directory

- `README.md` — architecture overview, key findings, Happy takeaways
- `sources.md` — this file
- `sync-architecture.md` — full state ownership map, all data flow paths
- `terminal-sync.md` — terminal state sync (V1 daemon + V2 WebSocket architectures)
- `electric-sql.md` — Electric SQL evaluation (API, performance, alternatives)

## Notes

- Host-service architecture doc at `HOST_SERVICE_ARCHITECTURE.md` explicitly
  states "deployable standalone with zero Electron awareness"
- The `agentCommands` cloud DB table is the CLI→desktop control mechanism
- Electric SQL is used via `@electric-sql/client` v1.5.13 + `@tanstack/db` v0.5.33
- Panes package uses Zustand vanilla store — framework-agnostic core
- camelCase columns = local-only, snake_case columns = synced from cloud
