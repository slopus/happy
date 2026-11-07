import { execFileSync } from 'node:child_process';
import { logger } from '@/ui/logger';

type CodexMcpListEntry = {
    name?: unknown;
    enabled?: unknown;
    transport?: unknown;
    startup_timeout_sec?: unknown;
    tool_timeout_sec?: unknown;
};

type CodexMcpTransport = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === 'string');
    return items.length === value.length ? items : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    const entries = Object.entries(record).filter((entry): entry is [string, string] => (
        typeof entry[1] === 'string'
    ));
    return entries.length === Object.keys(record).length ? Object.fromEntries(entries) : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractJsonArray(output: string): unknown {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start < 0 || end < start) {
        throw new Error('No JSON array found in `codex mcp list --json` output');
    }
    return JSON.parse(output.slice(start, end + 1));
}

export function codexMcpListEntriesToThreadConfig(entries: unknown): Record<string, unknown> {
    if (!Array.isArray(entries)) return {};

    const mcpServers: Record<string, unknown> = {};

    for (const entry of entries as CodexMcpListEntry[]) {
        const name = asString(entry.name);
        if (!name || entry.enabled === false) continue;

        const transport = asRecord(entry.transport);
        const server = transport ? codexMcpTransportToThreadConfig(transport) : null;
        if (!server) continue;

        const startupTimeout = asNumber(entry.startup_timeout_sec);
        if (startupTimeout !== undefined) {
            server.startup_timeout_sec = startupTimeout;
        }

        const toolTimeout = asNumber(entry.tool_timeout_sec);
        if (toolTimeout !== undefined) {
            server.tool_timeout_sec = toolTimeout;
        }

        mcpServers[name] = server;
    }

    return mcpServers;
}

function codexMcpTransportToThreadConfig(transport: CodexMcpTransport): Record<string, unknown> | null {
    const type = asString(transport.type);
    const config: Record<string, unknown> = {};

    if (type === 'stdio') {
        const command = asString(transport.command);
        if (!command) return null;

        config.command = command;
        const args = asStringArray(transport.args);
        if (args) config.args = args;

        const env = asStringRecord(transport.env);
        if (env) config.env = env;

        return config;
    }

    if (type === 'streamable_http' || type === 'sse') {
        const url = asString(transport.url);
        if (!url) return null;

        config.url = url;

        const bearerTokenEnvVar = asString(transport.bearer_token_env_var);
        if (bearerTokenEnvVar) config.bearer_token_env_var = bearerTokenEnvVar;

        const httpHeaders = asStringRecord(transport.http_headers);
        if (httpHeaders) config.http_headers = httpHeaders;

        const envHttpHeaders = asStringRecord(transport.env_http_headers);
        if (envHttpHeaders) config.env_http_headers = envHttpHeaders;

        return config;
    }

    return null;
}

export function readConfiguredCodexMcpServers(): Record<string, unknown> {
    try {
        const output = execFileSync('codex', ['mcp', 'list', '--json'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return codexMcpListEntriesToThreadConfig(extractJsonArray(output));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.debug(`[codex] Failed to read configured MCP servers: ${reason}`);
        return {};
    }
}
