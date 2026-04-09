# Superset

Deep research completed 2026-04-08 from `github.com/superset-sh/superset`.

**Repo:** `github.com/superset-sh/superset` | **Stars:** 9,092 | **License:** Elastic License 2.0 (ELv2)

## Why it matters

Superset takes a fundamentally different approach from other coding agents:
it focuses on **orchestration** rather than terminal emulation or streaming
event plumbing. It doesn't try to understand agent output — it launches
agents in real PTY terminals, observes their lifecycle via hooks, and
coordinates via git worktrees.

- 3-person team shipping daily for 5+ months (2,100+ commits, 80+ releases)
- excellent package boundaries — host-service is deployment-agnostic,
  panes engine is framework-agnostic, sync is layered cleanly
- CLI can control the desktop app remotely via cloud DB command queue
- agent-agnostic: launches Claude, Codex, Gemini, etc. as opaque processes

## Current take

- Superset is the strongest reference for **orchestration-layer design** —
  how to coordinate multiple agents without owning their protocols.
- Their host-service extraction pattern (injectable providers, no Electron
  awareness) is worth studying for Happy's own server/CLI split.
- The Electric SQL cloud-to-local sync is a real production pattern worth
  understanding for Happy's sync story.
- Ship velocity is remarkable — they're actively doing a v2 refactor while
  shipping features daily.

## Key architectural findings

### 1. Monorepo structure (Turborepo + Bun)

**Apps (7+):**
- `apps/desktop` — Electron desktop app (primary product), React 19, xterm.js
- `apps/api` — Next.js cloud API (Neon Postgres, Better Auth, tRPC)
- `apps/web` — Next.js web dashboard
- `apps/electric-proxy` — Cloudflare Worker proxying Electric SQL shape streams
- `apps/mobile` — Expo React Native mobile app
- `apps/admin`, `apps/docs`, `apps/marketing`

**Packages (15+):**
- `@superset/host-service` — **core backend.** Hono HTTP + WebSocket. Manages
  workspaces, terminals (node-pty), filesystem, git, AI chat, PRs. Own SQLite
  DB (Drizzle + better-sqlite3). Zero Electron awareness — accepts injected
  providers via `createApp()` factory.
- `@superset/workspace-client` — React client library. tRPC + React Query
  clients pointing at a host-service instance.
- `@superset/shared` — Agent definitions, command building, task templates.
  Zero framework dependencies.
- `@superset/cli` — Bun-compiled CLI. File-based command routing via
  `@superset/cli-framework`. Commands: auth, devices, host, tasks, workspaces.
- `@superset/local-db` — Desktop-local SQLite (Drizzle). Projects, worktrees,
  workspaces, settings, plus **synced tables** mirroring cloud Postgres via
  Electric SQL.
- `@superset/db` — Cloud Postgres schema (Drizzle). Tasks, users, orgs,
  agent commands, device presence.
- `@superset/panes` — **Standalone binary-tree pane layout engine** with
  Zustand vanilla store. Framework-agnostic core + React bindings. Tabs,
  splits, drag-and-drop, resize.
- `@superset/workspace-fs` — Filesystem ops, fuzzy search (VS Code scorer
  port), watching (@parcel/watcher), resource URIs.
- `@superset/mcp` — MCP server for remote device control: create/delete
  workspaces, start agent sessions, switch workspaces, list devices.
- `@superset/chat` — AI chat runtime (client/server/shared).

### 2. Sync — three distinct layers

**Layer 1: Local SQLite** — per-device desktop state (projects, worktrees,
workspaces, settings). Schema at `packages/local-db/src/schema/schema.ts`.

**Layer 2: Electric SQL** — cloud-to-local real-time sync. The electric-proxy
Worker authenticates and proxies shape streams. Desktop uses
`@electric-sql/client` + `@tanstack/db` to subscribe and write into local
SQLite. Gives offline-capable access to org data, tasks, users.

**Layer 3: WebSocket EventBus** — real-time host-service events. Two event
types: `git:changed` (auto-broadcast on git state changes, 300ms debounce)
and `fs:events` (on-demand per-client filesystem subscriptions). Client-side
ref-counting, auto-reconnect with exponential backoff (1s–30s).

**Layer 4: tRPC** — request-response over HTTP. Host-service exposes
`/trpc/*` routes for health, chat, filesystem, git, github, PRs, workspaces.

### 3. CLI controlling the UI — cloud-mediated command queue

The `agentCommands` table in cloud Postgres acts as a **command queue**:

1. CLI/MCP tool inserts a row: `status: "pending"`, `tool`, `params`,
   `targetDeviceId`, `timeoutAt`
2. MCP server **polls** the row every 500ms waiting for completion
3. Desktop picks up pending commands (via Electric SQL sync), executes
   locally, updates status to `completed`/`failed` with result
4. MCP server sees completion and returns result

No direct WebSocket from CLI to desktop — the cloud DB is the rendezvous
point. This is elegant for remote device control.

### 4. Host-service durability

Host-service **survives app restarts**. On spawn, writes a manifest file
(`~/.superset/host/<orgId>/manifest.json`) with `{pid, endpoint, authToken,
startedAt, protocolVersion}`. On next launch, `HostServiceManager` scans
manifests, health-checks PIDs, and adopts running instances. On normal quit,
detaches without killing services.

### 5. Orchestration model — agent-agnostic

The key insight: Superset does NOT parse or understand agent output streams.

- **Workspace isolation via git worktrees** — each task gets its own worktree
- **Agent-agnostic launch** — agents are CLI command strings launched in real
  PTY terminals: `claude --dangerously-skip-permissions`, `codex --bypass...`,
  `gemini --yolo`, etc.
- **Lifecycle observation, not control** — uses notify hooks and git watchers
  to know when agents start/stop/need attention, but never injects into
  stdin/stdout
- **Task → Agent mapping** — `buildAgentCommand()` renders task metadata into
  a prompt template, writes to `.superset/task-<slug>.md`, passes via
  `--resume` or stdin
- **Pane layout as orchestration surface** — binary-tree layout (like tmux)
  with Zustand. Multiple agents in separate panes/tabs.

### 6. Agent lifecycle hooks

For Claude: merges hook definitions into `~/.claude/settings.json` that call
a `notify.sh` script → hits `GET http://localhost:<port>/hook/complete` →
Express server receives, validates, emits via `notificationsEmitter`. This
is how the desktop knows when agents need attention.

## Ship velocity

- **2,176 commits** on main in ~5.5 months (since Oct 21, 2025)
- **3 core contributors** doing 95%+ of work: Kitenite (1,300), saddlepaddle
  (460), AviPeltz (243)
- **15 releases in 17 days** (Mar 17 – Apr 3, v1.2.0 → v1.4.7)
- **67 releases** from v0.0.12 to v0.0.67 (Dec 9 – Feb 4)
- **~5–7 commits/day** with substantive features
- Currently doing a v2 architectural refactor while shipping daily

## Happy takeaways

- The host-service extraction pattern (injectable providers, zero Electron
  awareness, manifest-based durability) is directly relevant to how Happy
  structures its CLI/server split.
- Electric SQL for cloud-to-local sync is a production-proven pattern worth
  evaluating against Happy's current sync approach.
- The cloud DB command queue for CLI→desktop control is clever — no direct
  connection needed, works across networks.
- The "don't parse agent output, just observe lifecycle" philosophy is the
  opposite of what OpenCode/Claude do — worth understanding the tradeoffs.
- Pane layout as a standalone package with Zustand is a good reference for
  any layout engine work in Happy.
