# MCP Server Management UI — Design Document

## Problem

All MCP servers from `~/.claude.json` start automatically and consume tokens in every session. There's no way to enable/disable specific servers per-session or globally from the Happy app UI.

## Solution

A full MCP server management system with two entry points:
1. **Quick toggle button** in the input area (next to paperclip)
2. **Full settings screen** at `/settings/mcp`

Servers are toggled by modifying `~/.claude.json` directly. A separate registry file preserves configs of disabled servers for re-enabling.

---

## Architecture

### Data Flow

```
~/.claude.json (mcpServers)     ← only ENABLED servers (source of truth for Claude Code)
~/.claude/mcp-registry.json     ← ALL servers with full configs + enabled/disabled state
Happy MMKV (localSettings)      ← default preferences for new sessions
Happy MMKV (session state)      ← per-session overrides
```

### Sync Logic

**First launch:**
1. Read `~/.claude.json` → `mcpServers`
2. If `~/.claude/mcp-registry.json` doesn't exist → create from mcpServers (all enabled)
3. If exists → merge (new servers from claude.json added to registry)

**Toggle OFF:**
1. Remove server from `~/.claude.json` `mcpServers`
2. Set `enabled: false` in registry (full config preserved)

**Toggle ON:**
1. Take config from registry
2. Add to `~/.claude.json` `mcpServers`
3. Set `enabled: true` in registry

**External changes detected:**
- On every GET /v1/mcp/servers, compare claude.json with registry
- New servers in claude.json → add to registry as enabled
- Servers missing from claude.json but in registry → mark as disabled

---

## Docker Configuration

```yaml
# docker-compose.yml — happy-server volumes
volumes:
  - /:/host-root:ro
  - /root/.claude:/claude-config:rw  # NEW: read-write for MCP management
```

Server reads/writes via `/claude-config/` path.

---

## API Endpoints (happy-server)

### `GET /v1/mcp/servers`

Returns all known servers with their status.

**Response:**
```json
{
  "servers": [
    {
      "name": "context7",
      "enabled": true,
      "type": "stdio",
      "command": "node",
      "args": ["/opt/mcpclaude/node_modules/@anthropic-ai/context7-mcp/dist/index.js"],
      "toolCount": 2
    },
    {
      "name": "figma",
      "enabled": false,
      "type": "http",
      "url": "https://mcp.figma.com/mcp",
      "toolCount": 15
    }
  ]
}
```

### `POST /v1/mcp/servers/:name/enable`

Moves server config from registry back into `~/.claude.json` mcpServers.

**Response:** `{ "ok": true }`

### `POST /v1/mcp/servers/:name/disable`

Removes server from `~/.claude.json` mcpServers, preserves in registry.

**Response:** `{ "ok": true }`

### `GET /v1/mcp/servers/:name/tools`

Returns tools for a specific server (extracted from session metadata by `mcp__<name>__` prefix).

**Query params:** `?sessionId=<id>` (to get tools from active session metadata)

**Response:**
```json
{
  "tools": ["mcp__context7__resolve-library-id", "mcp__context7__query-docs"]
}
```

---

## UI Components

### A. Input Area Button (AgentInput.tsx)

**Location:** Left button group, after attach button, before swap button.

**Appearance:**
- Icon: `extension-puzzle-outline` (Ionicons)
- Badge: `5/8` format (enabled/total) — only shown when some are disabled
- Same styling as attach button (height 38, paddingHorizontal 10, borderRadius 20)

**Behavior:**
- Press → open FloatingOverlay popup above input
- Popup dismissed by tapping backdrop

### B. MCP Server Popup (MCPServerPopup.tsx) — NEW

**Layout:**
```
┌─────────────────────────────┐
│  MCP Servers            5/8 │
├─────────────────────────────┤
│  ● context7         [====]  │
│    stdio · 2 tools          │
│  ● playwright       [====]  │
│    stdio · 45 tools         │
│  ○ figma            [    ]  │
│    http · 15 tools          │
│  ● taskmaster       [====]  │
│    stdio · 8 tools          │
│  ...                        │
├─────────────────────────────┤
│  ⚙ Manage Servers...        │
└─────────────────────────────┘
```

**Each server row:**
- Status dot (green=enabled, gray=disabled)
- Server name (formatted, e.g., "Context7", "Playwright")
- Switch toggle
- Subtitle: type + tool count
- Per-session override indicator (if different from global)

**Footer:** "Manage Servers..." → navigates to `/settings/mcp`

### C. Settings Screen (/settings/mcp.tsx) — NEW

**Full management screen with ItemGroup sections:**

**Section 1: "Active Servers"**
- All enabled servers with Switch toggles
- Each Item shows: icon, name, type, tool count, command/URL preview

**Section 2: "Disabled Servers"**
- All disabled servers with Switch toggles
- Grayed out appearance

**Section 3: "Session Defaults"**
- Footer explaining: "Servers enabled by default for new sessions"
- Toggle for each server

---

## Storage

### File: `~/.claude/mcp-registry.json`

```json
{
  "servers": {
    "context7": {
      "config": {
        "type": "stdio",
        "command": "node",
        "args": ["/opt/mcpclaude/node_modules/@anthropic-ai/context7-mcp/dist/index.js"],
        "env": {}
      },
      "enabled": true,
      "addedAt": "2026-03-05T00:00:00Z"
    },
    "figma": {
      "config": {
        "type": "http",
        "url": "https://mcp.figma.com/mcp"
      },
      "enabled": false,
      "addedAt": "2026-03-05T00:00:00Z"
    }
  },
  "version": 1
}
```

### App Storage (MMKV)

**localSettings.ts — new field:**
```typescript
mcpDefaultServers: z.record(z.string(), z.boolean())
  .describe('Default MCP server enabled state for new sessions')
```

**storageTypes.ts — Session interface, new field:**
```typescript
disabledMcpServers?: string[] | null;
// Per-session override: servers disabled only for this session
```

**persistence.ts — new functions:**
```typescript
loadSessionDisabledMcpServers(): Record<string, string[]>
saveSessionDisabledMcpServers(data: Record<string, string[]>): void
```

---

## Per-Session Override

- By default, session uses the global server set from `~/.claude.json`
- In the popup, user can disable a server for THIS session only
- Visual indicator: server row shows "session override" badge
- Stored in `Session.disabledMcpServers` (MMKV, per-session)
- When sending messages: system instruction added "Do not use tools from: X, Y"
- Override cleared when session is archived/deleted

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `docker-compose.yml` | MODIFY | Add rw mount `/root/.claude:/claude-config:rw` |
| `happy-server/sources/app/api/routes/mcpRoutes.ts` | CREATE | API endpoints for MCP management |
| `happy-server/sources/app/api/routes/index.ts` | MODIFY | Register mcpRoutes |
| `happy-app/sources/sync/localSettings.ts` | MODIFY | Add `mcpDefaultServers` field |
| `happy-app/sources/sync/storageTypes.ts` | MODIFY | Add `disabledMcpServers` to Session |
| `happy-app/sources/sync/persistence.ts` | MODIFY | Add load/save for per-session MCP |
| `happy-app/sources/sync/storage.ts` | MODIFY | Add `updateSessionDisabledMcpServers` |
| `happy-app/sources/components/AgentInput.tsx` | MODIFY | Add MCP button + popup trigger |
| `happy-app/sources/components/MCPServerPopup.tsx` | CREATE | Popup component with server list |
| `happy-app/sources/app/(app)/settings/mcp.tsx` | CREATE | Full settings screen |
| `happy-app/sources/components/SettingsView.tsx` | MODIFY | Add MCP Servers nav item |

---

## Limitations & Future Work

- Toggle affects new sessions only (running sessions keep their MCP set until restart)
- No MCP server installation/marketplace (manual setup via CLI)
- No server health monitoring (just enabled/disabled state)
- Per-session override uses system prompt instruction (not real tool filtering)
- No `.mcp.json` (project-level config) management — global only
