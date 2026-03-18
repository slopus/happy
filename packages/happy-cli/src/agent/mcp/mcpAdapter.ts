/**
 * MCP Adapter - Single source of truth for MCP server configuration
 *
 * Each AI agent requires a different MCP config format:
 * - Claude: HTTP direct  → { type: 'http', url }
 * - Codex:  STDIO bridge → { command, args }
 * - Gemini: HTTP direct  → { type: 'http', url }
 *
 * This module defines a canonical format and adapts it per-agent,
 * so adding a new MCP server only requires a change in one place.
 */

import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';
import type { McpServerHttpConfig, McpServerStdioConfig } from '@/agent/core/AgentBackend';

/** Canonical MCP server definition - the single source of truth */
interface McpServerDefinition {
    /** HTTP URL of the running MCP server */
    url: string;
    /** Tool names this server provides (without prefix). Empty = auto-discovered by agent */
    toolNames: string[];
    /** Optional HTTP headers (e.g., auth tokens for external servers) */
    headers?: Record<string, string>;
    /** Cleanup function to stop the server */
    stop: () => void;
}

/** Claude-specific MCP server config (HTTP direct) */
interface ClaudeMcpServerConfig {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
}

/** Result of creating all MCP servers - provides per-agent adapted config */
export interface McpContext {
    /** Get MCP config adapted for Claude (HTTP direct) */
    configForClaude(): Record<string, ClaudeMcpServerConfig>;
    /** Get MCP config adapted for STDIO-based agents (Codex) */
    configForStdio(): Record<string, McpServerStdioConfig>;
    /** Get MCP config adapted for HTTP-capable ACP agents (Gemini) */
    configForHttp(): Record<string, McpServerHttpConfig>;
    /** Get all allowed tool names prefixed as mcp__<server>__<tool> */
    allowedToolNames(): string[];
    /**
     * Normalize a raw tool name to mcp:server:tool format (Codex-style).
     * Returns the prefixed name if the raw name matches a known MCP tool,
     * or the original name if no match is found.
     * Useful for agents (like Gemini) that don't prefix tool names.
     */
    normalizeToolName(rawName: string): string;
    /** Stop all MCP servers and release resources */
    stop(): void;
}

/** Build the STDIO bridge command path */
const getBridgeCommand = () => join(projectPath(), 'bin', 'happy-mcp.mjs');

/** Adapt a server for Claude: pass HTTP URL directly */
function adaptForClaude(def: McpServerDefinition): ClaudeMcpServerConfig {
    return { type: 'http', url: def.url, ...(def.headers && { headers: def.headers }) };
}

/** Adapt a server for STDIO-based agents: use the HTTP→STDIO bridge */
function adaptForStdio(def: McpServerDefinition): McpServerStdioConfig {
    const args = ['--url', def.url];
    if (def.headers) {
        for (const [k, v] of Object.entries(def.headers)) {
            args.push('--header', `${k}: ${v}`);
        }
    }
    return { command: getBridgeCommand(), args };
}

/** Adapt a server for HTTP-capable ACP agents: pass HTTP URL directly via ACP */
function adaptForHttp(def: McpServerDefinition): McpServerHttpConfig {
    return { type: 'http', url: def.url, headers: def.headers || {} };
}

/**
 * Create the MCP context with all servers started and ready.
 *
 * Usage:
 * ```ts
 * const mcp = await createMcpContext(session);
 * // For Claude:
 * mcpServers: mcp.configForClaude()
 * // For Codex:
 * mcpServers: mcp.configForStdio()
 * // For Gemini (HTTP direct via ACP):
 * mcpServers: mcp.configForHttp()
 * // Cleanup:
 * mcp.stop()
 * ```
 */
export async function createMcpContext(session: ApiSessionClient): Promise<McpContext> {
    const happyServer = await startHappyServer(session);

    const servers: Record<string, McpServerDefinition> = {
        happy: {
            url: happyServer.url,
            toolNames: happyServer.toolNames,
            stop: () => happyServer.stop(),
        },
    };

    // Merge extra MCP servers from environment (e.g., DooTask)
    const extraServersJson = process.env.HAPPY_EXTRA_MCP_SERVERS;
    if (extraServersJson) {
        try {
            const extraServers: Array<{ name: string; url: string; headers?: Record<string, string> }> =
                JSON.parse(extraServersJson);
            for (const srv of extraServers) {
                servers[srv.name] = {
                    url: srv.url,
                    toolNames: [],  // External MCP — tools discovered by agent, not whitelisted
                    headers: srv.headers,
                    stop: () => {},  // No lifecycle management for external servers
                };
            }
        } catch (e) {
            console.warn('Failed to parse HAPPY_EXTRA_MCP_SERVERS:', e);
        }
    }

    return {
        configForClaude() {
            const result: Record<string, ClaudeMcpServerConfig> = {};
            for (const [name, def] of Object.entries(servers)) {
                result[name] = adaptForClaude(def);
            }
            return result;
        },

        configForStdio() {
            const result: Record<string, McpServerStdioConfig> = {};
            for (const [name, def] of Object.entries(servers)) {
                result[name] = adaptForStdio(def);
            }
            return result;
        },

        configForHttp() {
            const result: Record<string, McpServerHttpConfig> = {};
            for (const [name, def] of Object.entries(servers)) {
                result[name] = adaptForHttp(def);
            }
            return result;
        },

        allowedToolNames() {
            // Keep explicit allow-list entries for known tools (e.g. happy/change_title)
            // even when some external MCP servers use auto-discovery.
            // Auto-discovered tools are simply omitted from this allow-list.
            return Object.entries(servers).flatMap(([name, def]) =>
                def.toolNames.map(tool => `mcp__${name}__${tool}`)
            );
        },

        normalizeToolName(rawName: string): string {
            // Build reverse lookup: raw tool name → mcp:server:tool
            for (const [name, def] of Object.entries(servers)) {
                if (def.toolNames.includes(rawName)) {
                    return `mcp:${name}:${rawName}`;
                }
            }
            return rawName;
        },

        stop() {
            for (const def of Object.values(servers)) {
                def.stop();
            }
        },
    };
}
