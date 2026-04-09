# Superset Sync Architecture

Deep dive completed 2026-04-08 from `github.com/superset-sh/superset`.

## High-level overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      CLOUD POSTGRES                             │
│  Source of truth for: users, orgs, tasks, agent commands,       │
│  integrations, subscriptions, GitHub data, device presence      │
│                                                                 │
│  Write path: tRPC mutations from any client                     │
│  Read path: Electric SQL WAL tailing → shape streams            │
└───────────────┬─────────────────────────────┬───────────────────┘
                │ Electric SQL                │ tRPC
                │ (real-time sync)            │ (mutations)
                ▼                             ▲
┌─────────────────────────────────────────────────────────────────┐
│  ELECTRIC PROXY (Cloudflare Worker)                             │
│  - JWT auth against JWKS endpoint                               │
│  - Injects WHERE org_id = ? per table (row-level security)      │
│  - Strips sensitive columns (tokens, secrets)                   │
│  - Forwards Electric protocol params (live, offset, cursor)     │
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTP shape streams
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  DESKTOP APP (Electron renderer)                                │
│                                                                 │
│  TanStack Electric Collections (22 shapes per org):             │
│    tasks, taskStatuses, projects, members, users,               │
│    agentCommands, integrations, subscriptions, ...              │
│                                                                 │
│  Write: optimistic local update → tRPC → Postgres →             │
│         Electric confirms via txid                              │
│                                                                 │
│  localStorage Collections (3, no sync):                         │
│    sidebarProjects, workspaceLocalState, sidebarSections        │
└───────────┬─────────────────────────────────┬───────────────────┘
            │ electron-trpc IPC               │ HTTP/WS
            ▼                                 ▼
┌─────────────────────────┐  ┌────────────────────────────────────┐
│  LOCAL SQLITE            │  │  HOST-SERVICE (per org)            │
│  (~/.superset/)          │  │  separate Node process, survives   │
│                          │  │  app restarts via manifest.json    │
│  LOCAL-ONLY:             │  │                                    │
│  - projects              │  │  OWN SQLITE:                       │
│  - worktrees             │  │  - terminalSessions                │
│  - workspaces            │  │  - projects (repo metadata)        │
│  - settings              │  │  - pullRequests (cache)            │
│  - browserHistory        │  │  - workspaces (worktree paths)     │
│                          │  │                                    │
│  SYNCED (Electric):      │  │  EVENTS (WebSocket EventBus):      │
│  - users                 │  │  - git:changed (broadcast, 300ms)  │
│  - organizations         │  │  - fs:events (per-subscriber)      │
│  - tasks                 │  │                                    │
└──────────────────────────┘  └────────────────────────────────────┘
```

## State ownership map

Superset distributes state across **four separate stores**, each with a
clear owner and sync strategy.

### 1. Cloud Postgres (source of truth for shared data)

Owner: API server. Written via tRPC mutations from any client.

**Auth tables** (`auth.*`): users, sessions, accounts, organizations,
members, invitations, OAuth clients/tokens/consents, API keys, device codes,
JWKs, verifications.

**Public tables:**
- `tasks` — full task data with Linear/GitHub sync (`external_provider`,
  `external_id`), assignee, status FK, labels JSON
- `taskStatuses` — per-org customizable statuses with position/color/type
- `integrationConnections` — OAuth tokens for Linear/GitHub/Slack per org
- `subscriptions` — Stripe billing
- `devicePresence` — online devices with `lastSeenAt` for command routing
- `agentCommands` — the CLI→desktop command queue (see below)
- `projects` — cloud-side project registry (org-scoped, GitHub-linked)
- `workspaces` — cloud workspaces, type enum `"local" | "cloud"`, JSON config
- `secrets` — encrypted environment variables per project
- `sandboxImages` — Dockerfile-like config per project
- `chatSessions` + `sessionHosts` — chat session tracking
- `usersSlackUsers` — Slack user mapping

**v2 tables** (newer architecture):
- `v2Projects`, `v2Hosts`, `v2Clients`, `v2UsersHosts`, `v2Workspaces`

**GitHub tables:**
- `githubInstallations`, `githubRepositories`, `githubPullRequests`

**Ingest tables** (`ingest.*`):
- `webhookEvents` — raw payloads from Linear/GitHub/Slack with processing
  state machine (`pending`/`processed`/`failed`/`skipped`)

### 2. Desktop local SQLite (~/.superset/local.db)

Owner: Electron main process. No cloud sync — purely local state.

**Local-only tables** (camelCase columns):
- `projects` — git repos the user opened (path, name, color, tabOrder,
  defaultBranch, githubOwner, neonProjectId)
- `worktrees` — git worktrees within a project (path, branch, baseBranch,
  gitStatus JSON, githubStatus JSON, createdBySuperset flag)
- `workspaces` — active workspaces, type `"worktree"|"branch"`, tabOrder,
  deletingAt, portBase, sectionId
- `workspaceSections` — user-created groups for organizing workspaces
- `settings` — singleton row: terminal presets, agent presets, ringtone,
  font settings, branch prefix mode
- `browserHistory` — URL autocomplete with visit counts

**Synced tables** (snake_case columns matching Postgres exactly):
- `users` — id, clerk_id, name, email, avatar_url
- `organizations` — id, clerk_org_id, name, slug, github_org
- `organizationMembers` — organization_id, user_id, role
- `tasks` — full task data mirrored from cloud

The naming convention IS the boundary marker: **camelCase = local-only,
snake_case = synced from cloud via Electric SQL.**

### 3. Host-service SQLite (~/.superset/host/{orgId}/host.db)

Owner: host-service process (one per org). Separate from desktop local-db.

- `terminalSessions` — PTY lifecycle tracking (id, status, originWorkspaceId)
- `projects` — repo metadata for host-service's own use
- `pullRequests` — cached PR state (number, branch, SHA, review decision, checks)
- `workspaces` — worktree path mapping for terminal/git operations

Uses `better-sqlite3` with WAL journal mode and foreign keys enabled.

### 4. Renderer localStorage (client-side only)

Owner: Electron renderer process. No sync.

- `v2SidebarProjects` — expansion/collapse state
- `v2WorkspaceLocalState` — last pane layout
- `v2SidebarSections` — sidebar grouping

These use `localStorageCollectionOptions` with Zod schemas in TanStack DB.

---

## Data flow paths

### Read path (cloud → client)

```
Postgres (source of truth)
    → Postgres logical replication (WAL tailing)
    → Electric SQL service (Elixir, shapes per table)
    → Electric Proxy (Cloudflare Worker)
        - JWT auth against JWKS endpoint
        - Injects WHERE org_id = ? per table (row-level security)
        - Strips sensitive columns (tokens, secrets)
        - Forwards Electric protocol params (live, offset, cursor)
    → TanStack Electric Collection (in-memory reactive store)
    → useLiveQuery() in React components
```

**22 Electric shape subscriptions** per organization on desktop:
tasks, taskStatuses, projects, v2Projects, v2Hosts, v2Clients,
v2UsersHosts, v2Workspaces, workspaces, members, users, invitations,
agentCommands, integrationConnections, subscriptions, apiKeys,
chatSessions, sessionHosts, githubRepositories, githubPullRequests,
plus organizations (global, not org-scoped).

**Mobile subscribes to only 6 shapes**: tasks, taskStatuses, projects,
members, users, invitations. Auth via cookies instead of Bearer tokens.
Routes through API server (`/api/electric/v1/shape`) not dedicated proxy.

### Write path (client → cloud)

```
Client UI action
    → optimistic local update (TanStack Collection)
    → tRPC mutation to cloud API
    → Postgres INSERT/UPDATE
    → Electric SQL WAL tail picks it up
    → shape stream to all subscribers
    → TanStack Collection confirms via txid (resolves optimistic write)
```

Writes are **asymmetric** — they go through tRPC, not Electric. Electric
is read-only. The `txid` return value from tRPC mutations lets TanStack
know when the server has confirmed the optimistic local update.

### Real-time events path (host-service → clients)

```
Git directory change on disk
    → fs.watch(gitDir, { recursive: true }) in GitWatcher
    → 300ms debounce
    → EventBus.broadcast({ type: "git:changed", workspaceId })
    → WebSocket to all connected clients
    → useGitChangeEvents() triggers React Query invalidation
```

WebSocket EventBus runs inside host-service. Two message types:
- `git:changed` — broadcast to ALL clients, driven by GitWatcher
- `fs:events` — on-demand per-client, ref-counted subscriptions

Client-side: single WebSocket per hostUrl (singleton), auto-reconnect
with exponential backoff (1s base, 30s max), re-sends all `fs:watch`
subscriptions on reconnect.

GitWatcher rescans DB for workspaces every 30 seconds to auto-discover
new workspaces and drop watchers for removed ones.

### Command queue path (CLI/MCP → desktop)

```
MCP tool / CLI command / Slack bot
    → tRPC mutation: INSERT INTO agent_commands (status='pending',
      tool, params, targetDeviceId, timeoutAt)
    → Electric SQL syncs row to desktop's agentCommands collection
    → useLiveQuery filters: status="pending" AND targetDeviceId matches
    → executeTool(tool, params) runs locally on desktop
    → collection.update(id, { status: 'completed', result })
    → tRPC mutation writes result back to Postgres
    → Electric confirms, MCP server sees completion
```

**Desktop side is reactive** (via Electric SQL `useLiveQuery`), not polling.
MCP server side polls every 500ms waiting for status change.

Available tools executed on desktop: createWorkspace, deleteWorkspace,
getAppContext, getWorkspaceDetails, listProjects, listWorkspaces,
startAgentSession, startAgentSessionWithPrompt, switchWorkspace,
updateWorkspace.

### Host-service durability path

```
Spawn: Electron forks Node process with ELECTRON_RUN_AS_NODE=1
    → child sends { type: "ready", port } via IPC
    → parent writes manifest to ~/.superset/host/{orgId}/manifest.json
      (pid, endpoint, authToken, serviceVersion, protocolVersion, startedAt)
    → manifest written with mode 0o600 (owner-only)

Restart: discoverAndAdoptAll() scans ~/.superset/host/ for manifests
    → isProcessAlive(pid) via process.kill(pid, 0)
    → health check: GET {endpoint}/trpc/health.check (3s timeout)
    → protocol version check
    → if all pass: adopt (no new process)

Normal quit: releaseAll() detaches IPC, leaves process running
    → KEEP_ALIVE_AFTER_PARENT=1 env var keeps host-service alive
    → manifest stays on disk for next launch to adopt

Crash: liveness poll every 5s for adopted processes
    → if dead: mark "degraded", schedule restart
    → exponential backoff: min(1000 * 2^restartCount, 30000)ms
```

---

## Electric Proxy detail

The Cloudflare Worker at `apps/electric-proxy/` handles:

**Auth**: Client sends `Authorization: Bearer <JWT>`. Proxy verifies
against app's JWKS endpoint (`/api/auth/jwks`) using `jose`. JWT contains
`sub`, `email`, and `organizationIds[]`.

**Row-level security**: Builds parameterized WHERE clause per table:
```
tasks           → WHERE organization_id = $1
agent_commands  → WHERE organization_id = $1
auth.users      → WHERE $1 = ANY(organization_ids)
auth.apikeys    → WHERE metadata LIKE '%organizationId:$1%'
```
20+ tables, each with org-scoped filtering.

**Column restrictions**: Strips sensitive columns:
```
auth.apikeys              → only: id, name, start, created_at, last_request
integration_connections   → excludes: accessToken, refreshToken
```

**Protocol forwarding**: Passes Electric params (`live`, `handle`,
`offset`, `cursor`) and injects source credentials (`ELECTRIC_SOURCE_ID`
/ `ELECTRIC_SOURCE_SECRET`).

---

## Collections caching

Desktop caches collections per org (`collectionsCache: Map<string,
OrgCollections>`). Collections can be eagerly preloaded via
`preloadCollections()`. Each workspace gets its own
`WorkspaceClientProvider` with a separate `QueryClient` (5s stale time,
30min GC time).
