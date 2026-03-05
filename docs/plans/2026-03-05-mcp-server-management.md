# MCP Server Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to toggle MCP servers on/off from the Happy app UI, both globally (modifying `~/.claude.json`) and per-session.

**Architecture:** Server-side API reads/writes `~/.claude.json` and a registry file via a Docker rw mount. Frontend shows a popup in the input area and a full settings screen. Per-session overrides stored in MMKV.

**Tech Stack:** Fastify (server), React Native + Expo Router (app), Zustand + MMKV (state), Zod (validation)

---

### Task 1: Docker mount for read-write access

**Files:**
- Modify: `/opt/llmchat/docker-compose.yml:126-128`

**Step 1: Add rw volume mount**

In `docker-compose.yml`, in the `happy-server` service `volumes` section (after line 128), add a new mount:

```yaml
    volumes:
      - /:/host-root:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /root/.claude:/claude-config:rw
```

**Step 2: Verify mount works**

Run: `docker compose up -d happy-server`
Run: `docker exec llmchat-server ls /claude-config/claude.json`
Expected: File listed without errors.

Run: `docker exec llmchat-server touch /claude-config/.write-test && docker exec llmchat-server rm /claude-config/.write-test`
Expected: No errors (confirms write access).

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add rw mount for MCP server management"
```

---

### Task 2: Server-side MCP routes — registry logic

**Files:**
- Create: `/opt/llmchat/packages/happy-server/sources/app/api/routes/mcpRoutes.ts`

**Step 1: Create mcpRoutes.ts with registry sync logic**

```typescript
import { type Fastify } from '../types';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// Paths inside the container
const CLAUDE_JSON_PATH = '/claude-config/claude.json';
const REGISTRY_PATH = '/claude-config/mcp-registry.json';

interface McpServerConfig {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}

interface RegistryEntry {
    config: McpServerConfig;
    enabled: boolean;
    addedAt: string;
}

interface Registry {
    servers: Record<string, RegistryEntry>;
    version: number;
}

// Read claude.json mcpServers section
function readClaudeJson(): Record<string, McpServerConfig> {
    try {
        const raw = readFileSync(CLAUDE_JSON_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.mcpServers || {};
    } catch {
        return {};
    }
}

// Write only mcpServers back to claude.json (preserve other fields)
function writeClaudeJson(mcpServers: Record<string, McpServerConfig>): void {
    let existing: Record<string, unknown> = {};
    try {
        existing = JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf-8'));
    } catch { /* start fresh */ }
    existing.mcpServers = mcpServers;
    writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

// Read or create registry
function readRegistry(): Registry {
    if (existsSync(REGISTRY_PATH)) {
        try {
            return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
        } catch { /* fall through to create */ }
    }
    return { servers: {}, version: 1 };
}

function writeRegistry(registry: Registry): void {
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

// Sync registry with current claude.json state
function syncRegistry(): Registry {
    const mcpServers = readClaudeJson();
    const registry = readRegistry();
    const now = new Date().toISOString();

    // Add new servers from claude.json to registry
    for (const [name, config] of Object.entries(mcpServers)) {
        if (!registry.servers[name]) {
            registry.servers[name] = { config, enabled: true, addedAt: now };
        } else {
            // Update config if server exists and is enabled
            registry.servers[name].config = config;
            registry.servers[name].enabled = true;
        }
    }

    // Mark servers in registry that are missing from claude.json as disabled
    for (const [name, entry] of Object.entries(registry.servers)) {
        if (!mcpServers[name]) {
            entry.enabled = false;
        }
    }

    writeRegistry(registry);
    return registry;
}

export function mcpRoutes(app: Fastify) {
    // GET /v1/mcp/servers — list all servers with status
    app.get('/v1/mcp/servers', async (_req, reply) => {
        const registry = syncRegistry();
        const servers = Object.entries(registry.servers).map(([name, entry]) => ({
            name,
            enabled: entry.enabled,
            type: entry.config.type,
            command: entry.config.command || null,
            args: entry.config.args || null,
            url: entry.config.url || null,
        }));
        return reply.send({ servers });
    });

    // POST /v1/mcp/servers/:name/enable — enable a server
    app.post('/v1/mcp/servers/:name/enable', async (req, reply) => {
        const { name } = req.params as { name: string };
        const registry = syncRegistry();
        const entry = registry.servers[name];
        if (!entry) {
            return reply.status(404).send({ error: 'Server not found in registry' });
        }

        // Add to claude.json
        const mcpServers = readClaudeJson();
        mcpServers[name] = entry.config;
        writeClaudeJson(mcpServers);

        // Update registry
        entry.enabled = true;
        writeRegistry(registry);

        return reply.send({ ok: true });
    });

    // POST /v1/mcp/servers/:name/disable — disable a server
    app.post('/v1/mcp/servers/:name/disable', async (req, reply) => {
        const { name } = req.params as { name: string };
        const registry = syncRegistry();
        const entry = registry.servers[name];
        if (!entry) {
            return reply.status(404).send({ error: 'Server not found in registry' });
        }

        // Remove from claude.json
        const mcpServers = readClaudeJson();
        delete mcpServers[name];
        writeClaudeJson(mcpServers);

        // Update registry
        entry.enabled = false;
        writeRegistry(registry);

        return reply.send({ ok: true });
    });
}
```

**Step 2: Verify file compiles**

Run: `cd /opt/llmchat && docker exec llmchat-server npx tsx --eval "import('./sources/app/api/routes/mcpRoutes.ts')"`
Expected: No errors (or at least no syntax errors).

**Step 3: Commit**

```bash
git add packages/happy-server/sources/app/api/routes/mcpRoutes.ts
git commit -m "feat: add MCP server management API routes"
```

---

### Task 3: Register MCP routes in the server

**Files:**
- Modify: `/opt/llmchat/packages/happy-server/sources/app/api/api.ts:29,143`

**Step 1: Add import**

After line 29 (`import { previewProxyRoutes } ...`), add:

```typescript
import { mcpRoutes } from "./routes/mcpRoutes";
```

**Step 2: Register route**

After line 143 (`previewProxyRoutes(typed);`), add:

```typescript
mcpRoutes(typed);
```

**Step 3: Build and test**

Run: `docker compose build happy-server && docker compose up -d happy-server`
Run: `curl -s http://localhost:3005/v1/mcp/servers | python3 -m json.tool`
Expected: JSON with `servers` array containing all 8 MCP servers, all `enabled: true`.

**Step 4: Test toggle**

Run: `curl -s -X POST http://localhost:3005/v1/mcp/servers/icons8/disable | python3 -m json.tool`
Expected: `{ "ok": true }`

Run: `curl -s http://localhost:3005/v1/mcp/servers | python3 -m json.tool`
Expected: icons8 now has `enabled: false`.

Run: `docker exec llmchat-server cat /claude-config/claude.json | python3 -c "import sys,json; print(list(json.load(sys.stdin).get('mcpServers',{}).keys()))"`
Expected: icons8 NOT in the list.

Run: `curl -s -X POST http://localhost:3005/v1/mcp/servers/icons8/enable`
Expected: icons8 back in claude.json.

**Step 5: Commit**

```bash
git add packages/happy-server/sources/app/api/api.ts
git commit -m "feat: register MCP routes in server"
```

---

### Task 4: App storage — per-session MCP overrides

**Files:**
- Modify: `/opt/llmchat/packages/happy-app/sources/sync/storageTypes.ts:73`
- Modify: `/opt/llmchat/packages/happy-app/sources/sync/persistence.ts`
- Modify: `/opt/llmchat/packages/happy-app/sources/sync/storage.ts`

**Step 1: Add disabledMcpServers to Session interface**

In `storageTypes.ts`, after line 73 (`modelMode?:`), add:

```typescript
    disabledMcpServers?: string[] | null; // Per-session MCP server overrides, not synced to server
```

**Step 2: Add persistence functions**

In `persistence.ts`, after the `saveSessionPermissionModes` function, add:

```typescript
export function loadSessionDisabledMcpServers(): Record<string, string[]> {
    const data = mmkv.getString('session-disabled-mcp-servers');
    if (data) {
        try {
            return JSON.parse(data);
        } catch (e) {
            console.error('Failed to parse session disabled MCP servers', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDisabledMcpServers(data: Record<string, string[]>) {
    mmkv.set('session-disabled-mcp-servers', JSON.stringify(data));
}
```

**Step 3: Add update function in storage.ts**

In `storage.ts`, find `updateSessionModelMode` function. After it, add:

```typescript
updateSessionDisabledMcpServers: (sessionId: string, servers: string[] | null) => set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    const updatedSessions = {
        ...state.sessions,
        [sessionId]: {
            ...session,
            disabledMcpServers: servers,
        },
    };

    // Persist to MMKV
    const allDisabled: Record<string, string[]> = {};
    Object.entries(updatedSessions).forEach(([id, sess]) => {
        if (sess.disabledMcpServers && sess.disabledMcpServers.length > 0) {
            allDisabled[id] = sess.disabledMcpServers;
        }
    });
    saveSessionDisabledMcpServers(allDisabled);

    return { ...state, sessions: updatedSessions };
}),
```

Also add import for `saveSessionDisabledMcpServers` at the top of storage.ts.

**Step 4: Load on init**

In `storage.ts`, find where `loadSessionPermissionModes()` is called during initialization. After it, add similar loading for `loadSessionDisabledMcpServers()` and apply to sessions.

**Step 5: Commit**

```bash
git add packages/happy-app/sources/sync/storageTypes.ts packages/happy-app/sources/sync/persistence.ts packages/happy-app/sources/sync/storage.ts
git commit -m "feat: add per-session MCP server disabled state"
```

---

### Task 5: MCP Server Popup component

**Files:**
- Create: `/opt/llmchat/packages/happy-app/sources/components/MCPServerPopup.tsx`

**Step 1: Create the popup component**

```typescript
import React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useTheme, Typography } from '@/theme';
import { Switch } from '@/components/Switch';
import { FloatingOverlay } from '@/components/FloatingOverlay';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

interface McpServer {
    name: string;
    enabled: boolean;
    type: string;
    command?: string | null;
    url?: string | null;
}

interface MCPServerPopupProps {
    servers: McpServer[];
    loading: boolean;
    onToggle: (name: string, enabled: boolean) => void;
    disabledOverrides?: string[]; // per-session overrides
    onSessionOverride?: (name: string, disabled: boolean) => void;
}

function formatServerName(name: string): string {
    // context7 → Context7, page-design-guide → Page Design Guide
    return name
        .split(/[-_]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function MCPServerPopup(props: MCPServerPopupProps) {
    const theme = useTheme();
    const router = useRouter();
    const { servers, loading, onToggle, disabledOverrides = [] } = props;

    const enabledCount = servers.filter(s => s.enabled && !disabledOverrides.includes(s.name)).length;
    const totalCount = servers.length;

    return (
        <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
            {/* Header */}
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: 0.5,
                borderBottomColor: theme.colors.border,
            }}>
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
                    MCP Servers
                </Text>
                <Text style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}>
                    {enabledCount}/{totalCount}
                </Text>
            </View>

            {/* Loading */}
            {loading && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            )}

            {/* Server list */}
            {!loading && servers.map((server, index) => {
                const isSessionDisabled = disabledOverrides.includes(server.name);
                const effectiveEnabled = server.enabled && !isSessionDisabled;

                return (
                    <View
                        key={server.name}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 16,
                            paddingVertical: 10,
                            borderBottomWidth: index < servers.length - 1 ? 0.5 : 0,
                            borderBottomColor: theme.colors.border,
                            opacity: effectiveEnabled ? 1 : 0.5,
                        }}
                    >
                        {/* Status dot */}
                        <View style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            backgroundColor: effectiveEnabled ? '#34C759' : theme.colors.textSecondary,
                            marginRight: 10,
                        }} />

                        {/* Server info */}
                        <View style={{ flex: 1 }}>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.text,
                                ...Typography.default('medium'),
                            }}>
                                {formatServerName(server.name)}
                            </Text>
                            <Text style={{
                                fontSize: 11,
                                color: theme.colors.textSecondary,
                                marginTop: 1,
                                ...Typography.default(),
                            }}>
                                {server.type}{isSessionDisabled ? ' · session override' : ''}
                            </Text>
                        </View>

                        {/* Toggle */}
                        <Switch
                            value={effectiveEnabled}
                            onValueChange={(val) => onToggle(server.name, val)}
                        />
                    </View>
                );
            })}

            {/* Footer: Manage Servers */}
            {!loading && (
                <Pressable
                    onPress={() => router.push('/settings/mcp')}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderTopWidth: 0.5,
                        borderTopColor: theme.colors.border,
                        backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                        gap: 8,
                    })}
                >
                    <Ionicons name="settings-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.textLink,
                        ...Typography.default(),
                    }}>
                        Manage Servers...
                    </Text>
                </Pressable>
            )}
        </FloatingOverlay>
    );
}
```

**Step 2: Commit**

```bash
git add packages/happy-app/sources/components/MCPServerPopup.tsx
git commit -m "feat: add MCPServerPopup component"
```

---

### Task 6: Add MCP button to AgentInput

**Files:**
- Modify: `/opt/llmchat/packages/happy-app/sources/components/AgentInput.tsx`

**Step 1: Add props to AgentInputProps interface**

After `onAttach?: () => void;` (around line 65), add:

```typescript
    // MCP servers
    mcpServers?: Array<{ name: string; enabled: boolean; type: string }>;
    mcpLoading?: boolean;
    onMcpToggle?: (name: string, enabled: boolean) => void;
    onMcpPress?: () => void;
    showMcpPopup?: boolean;
    onMcpPopupDismiss?: () => void;
```

**Step 2: Add import for MCPServerPopup**

At the top of the file, add:

```typescript
import { MCPServerPopup } from '@/components/MCPServerPopup';
```

**Step 3: Add MCP button after attach button**

After the attach button Pressable (around line 1197, after the closing `)}` of the attach button), add:

```typescript
                                {/* MCP Servers button */}
                                {props.onMcpPress && (
                                    <View>
                                        <Pressable
                                            onPress={() => {
                                                hapticsLight();
                                                props.onMcpPress?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                borderRadius: Platform.select({ default: 20, android: 22 }),
                                                paddingHorizontal: 10,
                                                paddingVertical: 8,
                                                justifyContent: 'center',
                                                height: 38,
                                                opacity: p.pressed ? 0.7 : 1,
                                            })}
                                        >
                                            <Ionicons
                                                name="extension-puzzle-outline"
                                                size={22}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {props.mcpServers && props.mcpServers.some(s => !s.enabled) && (
                                                <View style={{
                                                    position: 'absolute',
                                                    top: 4,
                                                    right: 4,
                                                    backgroundColor: theme.colors.textLink,
                                                    borderRadius: 6,
                                                    minWidth: 12,
                                                    height: 12,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    paddingHorizontal: 2,
                                                }}>
                                                    <Text style={{ fontSize: 8, color: '#fff', fontWeight: '700' }}>
                                                        {props.mcpServers.filter(s => s.enabled).length}
                                                    </Text>
                                                </View>
                                            )}
                                        </Pressable>
                                    </View>
                                )}
```

**Step 4: Add MCP popup rendering**

Right before the settings overlay (`{showSettings && (`), add:

```typescript
                {/* MCP Server Popup */}
                {props.showMcpPopup && props.mcpServers && (
                    <>
                        <TouchableWithoutFeedback onPress={() => props.onMcpPopupDismiss?.()}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[styles.settingsOverlay, { paddingHorizontal: screenWidth > 700 ? 0 : 8 }]}>
                            <MCPServerPopup
                                servers={props.mcpServers}
                                loading={props.mcpLoading || false}
                                onToggle={(name, enabled) => props.onMcpToggle?.(name, enabled)}
                            />
                        </View>
                    </>
                )}
```

**Step 5: Commit**

```bash
git add packages/happy-app/sources/components/AgentInput.tsx
git commit -m "feat: add MCP server button and popup to AgentInput"
```

---

### Task 7: Wire MCP state in SessionView

**Files:**
- Modify: `/opt/llmchat/packages/happy-app/sources/-session/SessionView.tsx`

**Step 1: Add MCP state and fetch logic**

In SessionView component, add state for MCP servers:

```typescript
// MCP server management
const [mcpServers, setMcpServers] = React.useState<Array<{ name: string; enabled: boolean; type: string }>>([]);
const [mcpLoading, setMcpLoading] = React.useState(false);
const [showMcpPopup, setShowMcpPopup] = React.useState(false);

const fetchMcpServers = React.useCallback(async () => {
    setMcpLoading(true);
    try {
        const serverUrl = session.metadata?.host
            ? `https://${session.metadata.host}`
            : storage.getState().settings.serverURL;
        const res = await fetch(`${serverUrl}/v1/mcp/servers`);
        if (res.ok) {
            const data = await res.json();
            setMcpServers(data.servers || []);
        }
    } catch (e) {
        console.warn('Failed to fetch MCP servers', e);
    } finally {
        setMcpLoading(false);
    }
}, [session.metadata?.host]);

const handleMcpToggle = React.useCallback(async (name: string, enabled: boolean) => {
    // Optimistic update
    setMcpServers(prev => prev.map(s => s.name === name ? { ...s, enabled } : s));
    try {
        const serverUrl = session.metadata?.host
            ? `https://${session.metadata.host}`
            : storage.getState().settings.serverURL;
        const endpoint = enabled ? 'enable' : 'disable';
        await fetch(`${serverUrl}/v1/mcp/servers/${name}/${endpoint}`, { method: 'POST' });
    } catch (e) {
        console.warn('Failed to toggle MCP server', e);
        // Revert on error
        fetchMcpServers();
    }
}, [session.metadata?.host, fetchMcpServers]);

const handleMcpPress = React.useCallback(() => {
    setShowMcpPopup(prev => !prev);
    if (mcpServers.length === 0) fetchMcpServers();
}, [mcpServers.length, fetchMcpServers]);
```

**Step 2: Pass props to AgentInput**

Add to AgentInput props:

```typescript
mcpServers={mcpServers}
mcpLoading={mcpLoading}
onMcpToggle={handleMcpToggle}
onMcpPress={handleMcpPress}
showMcpPopup={showMcpPopup}
onMcpPopupDismiss={() => setShowMcpPopup(false)}
```

**Step 3: Commit**

```bash
git add packages/happy-app/sources/-session/SessionView.tsx
git commit -m "feat: wire MCP server state to AgentInput"
```

---

### Task 8: Settings screen for MCP servers

**Files:**
- Create: `/opt/llmchat/packages/happy-app/sources/app/(app)/settings/mcp.tsx`
- Modify: `/opt/llmchat/packages/happy-app/sources/components/SettingsView.tsx`

**Step 1: Create mcp.tsx settings screen**

```typescript
import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useTheme, Typography } from '@/theme';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { storage } from '@/sync/storage';

interface McpServer {
    name: string;
    enabled: boolean;
    type: string;
    command?: string | null;
    url?: string | null;
}

function formatServerName(name: string): string {
    return name
        .split(/[-_]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export default function McpSettingsScreen() {
    const theme = useTheme();
    const [servers, setServers] = React.useState<McpServer[]>([]);
    const [loading, setLoading] = React.useState(true);

    const serverUrl = storage.getState().settings.serverURL || 'https://app.304.systems';

    const fetchServers = React.useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${serverUrl}/v1/mcp/servers`);
            if (res.ok) {
                const data = await res.json();
                setServers(data.servers || []);
            }
        } catch (e) {
            console.warn('Failed to fetch MCP servers', e);
        } finally {
            setLoading(false);
        }
    }, [serverUrl]);

    React.useEffect(() => { fetchServers(); }, [fetchServers]);

    const handleToggle = React.useCallback(async (name: string, enabled: boolean) => {
        setServers(prev => prev.map(s => s.name === name ? { ...s, enabled } : s));
        try {
            const endpoint = enabled ? 'enable' : 'disable';
            await fetch(`${serverUrl}/v1/mcp/servers/${name}/${endpoint}`, { method: 'POST' });
        } catch (e) {
            console.warn('Failed to toggle MCP server', e);
            fetchServers();
        }
    }, [serverUrl, fetchServers]);

    const enabledServers = servers.filter(s => s.enabled);
    const disabledServers = servers.filter(s => !s.enabled);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="large" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {enabledServers.length > 0 && (
                <ItemGroup
                    title="Active Servers"
                    footer={`${enabledServers.length} server${enabledServers.length !== 1 ? 's' : ''} enabled. Changes apply to new sessions.`}
                >
                    {enabledServers.map((server) => (
                        <Item
                            key={server.name}
                            title={formatServerName(server.name)}
                            subtitle={`${server.type}${server.command ? ` · ${server.command}` : ''}${server.url ? ` · ${server.url}` : ''}`}
                            showChevron={false}
                            rightElement={
                                <Switch
                                    value={true}
                                    onValueChange={() => handleToggle(server.name, false)}
                                />
                            }
                        />
                    ))}
                </ItemGroup>
            )}

            {disabledServers.length > 0 && (
                <ItemGroup
                    title="Disabled Servers"
                    footer="Disabled servers are preserved and can be re-enabled."
                >
                    {disabledServers.map((server) => (
                        <Item
                            key={server.name}
                            title={formatServerName(server.name)}
                            subtitle={`${server.type}${server.command ? ` · ${server.command}` : ''}${server.url ? ` · ${server.url}` : ''}`}
                            showChevron={false}
                            rightElement={
                                <Switch
                                    value={false}
                                    onValueChange={() => handleToggle(server.name, true)}
                                />
                            }
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
}
```

**Step 2: Add MCP Servers item to SettingsView.tsx**

In `SettingsView.tsx`, find the ItemGroup that contains Profiles (around line 317). After the Profiles Item, add:

```typescript
<Item
    title="MCP Servers"
    subtitle={t('settings.mcpServers') || 'Manage MCP integrations'}
    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#8B5CF6" />}
    onPress={() => router.push('/settings/mcp')}
/>
```

Also add `Ionicons` to imports if not already present.

**Step 3: Commit**

```bash
git add packages/happy-app/sources/app/\(app\)/settings/mcp.tsx packages/happy-app/sources/components/SettingsView.tsx
git commit -m "feat: add MCP Servers settings screen"
```

---

### Task 9: Build, deploy, and verify

**Step 1: Build both containers**

```bash
cd /opt/llmchat
docker compose build happy-server happy-webapp
```

**Step 2: Deploy**

```bash
docker compose up -d happy-server happy-webapp
```

**Step 3: Verify API**

```bash
curl -s https://app.304.systems/v1/mcp/servers | python3 -m json.tool
```
Expected: All 8 servers listed.

**Step 4: Verify UI**

- Open Happy app
- Check input area → puzzle icon button visible
- Click puzzle icon → popup with server list and toggles
- Toggle a server off → server disappears from popup as enabled
- Go to Settings (Cmd+,) → MCP Servers → full management screen
- Toggle server back on

**Step 5: Verify claude.json**

```bash
cat ~/.claude.json | python3 -c "import sys,json; print(list(json.load(sys.stdin).get('mcpServers',{}).keys()))"
```
Expected: Disabled server missing from list.

**Step 6: Commit any fixes and final commit**

```bash
git add -A
git commit -m "feat: MCP Server Management UI — complete implementation"
```
