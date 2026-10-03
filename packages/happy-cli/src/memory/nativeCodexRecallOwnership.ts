import { RECALL_OWNER_ENV } from './recallOwnerMarker';

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

/** config/read normalizes optional fields to null; TOML overrides reject nulls. */
function omitNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.filter(item => item !== null).map(omitNulls);
    const object = record(value);
    return object ? Object.fromEntries(Object.entries(object)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, omitNulls(item)])) : value;
}

/** Preserve the native transport config and avoid unsupported quoted dotted keys. */
export function nativeCodexRecallOwnershipOverrides(
    nativeServers: unknown,
    runtimeServers?: Record<string, unknown>,
): Record<string, unknown> {
    const native = record(nativeServers) ?? {};
    const selected: Record<string, Record<string, unknown>> = Object.create(null);
    for (const name of new Set([...Object.keys(native), ...Object.keys(runtimeServers ?? {})])) {
        const base = record(native[name]) ?? {};
        const override = runtimeServers && Object.hasOwn(runtimeServers, name)
            ? record(runtimeServers[name]) : undefined;
        // Do not reinterpret an invalid runtime entry as an enabled native entry.
        if (runtimeServers && Object.hasOwn(runtimeServers, name) && !override) continue;
        const server = { ...base, ...override };
        if (server.enabled === false || server.url !== undefined || typeof server.command !== 'string') continue;
        const executable = server.command.split(/[\\/]/).at(-1)?.toLowerCase();
        if (!['claude-memory-layer-mcp', 'claude-memory-layer-mcp.cmd', 'claude-memory-layer-mcp.exe'].includes(executable ?? '')) continue;
        selected[name] = { ...server, env: { ...record(base.env), ...record(override?.env), [RECALL_OWNER_ENV]: 'host' } };
    }
    const names = Object.keys(selected);
    if (!names.length) return {};
    // A top-level runtime map replaces ALL native servers. Merge the full map
    // before marking CML so unrelated user servers do not disappear. Exotic
    // aliases also require this form: Codex splits quoted dots in leaf keys.
    if (runtimeServers !== undefined || names.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) {
        return { mcp_servers: {
            ...record(omitNulls(native)),
            ...runtimeServers,
            ...record(omitNulls(selected)),
        } };
    }
    return Object.fromEntries(names.map(name => [`mcp_servers.${name}.env.${RECALL_OWNER_ENV}`, 'host']));
}
