import { type Fastify } from '../types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ── Paths ───────────────────────────────────────────────────────

const CLAUDE_JSON_PATH = '/claude-config/claude.json';
const REGISTRY_PATH = '/claude-config/dotclaude/mcp-registry.json';

// ── Types ───────────────────────────────────────────────────────

interface McpServerConfig {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    [key: string]: unknown;
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

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Reads the full claude.json and returns the mcpServers map.
 * Returns empty object if file is missing or mcpServers key is absent.
 */
function readClaudeJson(): Record<string, McpServerConfig> {
    if (!existsSync(CLAUDE_JSON_PATH)) {
        return {};
    }
    const raw = JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf-8'));
    return (raw.mcpServers ?? {}) as Record<string, McpServerConfig>;
}

/**
 * Writes mcpServers back into claude.json while preserving every other key.
 */
function writeClaudeJson(mcpServers: Record<string, McpServerConfig>): void {
    let existing: Record<string, unknown> = {};
    if (existsSync(CLAUDE_JSON_PATH)) {
        existing = JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf-8'));
    }
    existing.mcpServers = mcpServers;
    writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(existing, null, 2), 'utf-8');
}

/**
 * Reads the MCP registry file. Returns a default empty registry if missing.
 */
function readRegistry(): Registry {
    if (!existsSync(REGISTRY_PATH)) {
        return { servers: {}, version: 1 };
    }
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
}

/**
 * Persists the registry to disk, creating parent directories if needed.
 */
function writeRegistry(registry: Registry): void {
    const dir = dirname(REGISTRY_PATH);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Synchronises claude.json state with the registry:
 * - Servers present in claude.json but missing from registry are added as enabled.
 * - Servers in registry that are no longer in claude.json are marked disabled
 *   (their config is preserved from the registry).
 * - Servers present in both keep the up-to-date config from claude.json and stay enabled.
 */
function syncRegistry(): Registry {
    const mcpServers = readClaudeJson();
    const registry = readRegistry();
    const now = new Date().toISOString();

    // Mark all registry entries as disabled first; we will re-enable those found in claude.json.
    for (const name of Object.keys(registry.servers)) {
        if (!(name in mcpServers)) {
            registry.servers[name].enabled = false;
        }
    }

    // Upsert every server from claude.json into the registry as enabled.
    for (const [name, config] of Object.entries(mcpServers)) {
        if (registry.servers[name]) {
            registry.servers[name].config = config;
            registry.servers[name].enabled = true;
        } else {
            registry.servers[name] = {
                config,
                enabled: true,
                addedAt: now,
            };
        }
    }

    writeRegistry(registry);
    return registry;
}

// ── Routes ──────────────────────────────────────────────────────

export function mcpRoutes(app: Fastify) {

    /**
     * GET /v1/mcp/servers
     * Returns all known MCP servers from the synced registry with their enabled status.
     */
    app.get('/v1/mcp/servers', async (_request, reply) => {
        const registry = syncRegistry();

        const servers = Object.entries(registry.servers).map(([name, entry]) => ({
            name,
            config: entry.config,
            enabled: entry.enabled,
            addedAt: entry.addedAt,
        }));

        reply.send({ servers });
    });

    /**
     * POST /v1/mcp/servers/:name/enable
     * Moves a server config from the registry into claude.json (enables it).
     */
    app.post('/v1/mcp/servers/:name/enable', async (request, reply) => {
        const { name } = request.params as { name: string };
        const registry = syncRegistry();

        const entry = registry.servers[name];
        if (!entry) {
            reply.code(404).send({ error: `Server "${name}" not found in registry` });
            return;
        }

        if (entry.enabled) {
            reply.send({ ok: true, message: `Server "${name}" is already enabled` });
            return;
        }

        // Add to claude.json
        const mcpServers = readClaudeJson();
        mcpServers[name] = entry.config;
        writeClaudeJson(mcpServers);

        // Update registry
        entry.enabled = true;
        writeRegistry(registry);

        reply.send({ ok: true });
    });

    /**
     * POST /v1/mcp/servers/:name/disable
     * Removes a server from claude.json but preserves its config in the registry.
     */
    app.post('/v1/mcp/servers/:name/disable', async (request, reply) => {
        const { name } = request.params as { name: string };
        const registry = syncRegistry();

        const entry = registry.servers[name];
        if (!entry) {
            reply.code(404).send({ error: `Server "${name}" not found in registry` });
            return;
        }

        if (!entry.enabled) {
            reply.send({ ok: true, message: `Server "${name}" is already disabled` });
            return;
        }

        // Remove from claude.json
        const mcpServers = readClaudeJson();
        delete mcpServers[name];
        writeClaudeJson(mcpServers);

        // Update registry
        entry.enabled = false;
        writeRegistry(registry);

        reply.send({ ok: true });
    });
}
