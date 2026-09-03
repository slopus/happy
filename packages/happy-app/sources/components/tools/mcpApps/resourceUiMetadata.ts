export const MCP_APP_MAX_UI_METADATA_BYTES = 16 * 1024;
export const MCP_APP_MAX_CSP_ORIGINS = 32;

export type McpAppResourceCsp = {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
};

export type McpAppResourcePermissions = {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
};

export type McpAppResourceUi = {
    csp?: McpAppResourceCsp;
    permissions?: McpAppResourcePermissions;
    prefersBorder?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(candidate: Record<string, unknown>, allowed: readonly string[]): boolean {
    const keys = new Set(allowed);
    return Object.keys(candidate).every((key) => keys.has(key));
}

function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function isLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalDevelopmentHttp(raw: string): boolean {
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/u.exec(raw);
    return Boolean(match && (match[1] === undefined || Number(match[1]) <= 65_535));
}

export function normalizeExactMcpAppOrigin(raw: unknown, development: boolean): string | null {
    if (typeof raw !== 'string' || byteLength(raw) > 2_048
        || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) return null;
    const withoutRootSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const separator = withoutRootSlash.indexOf('://');
    if (separator <= 0 || withoutRootSlash.slice(separator + 3).includes('/')) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || !url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) return null;
    if (url.protocol !== 'https:' && (url.protocol !== 'http:' || !development
        || !isLoopbackHostname(url.hostname) || !canonicalDevelopmentHttp(raw))) return null;
    return url.origin === 'null' ? null : url.origin;
}

function normalizeOriginArray(value: unknown, development: boolean): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MCP_APP_MAX_CSP_ORIGINS) return null;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        const origin = normalizeExactMcpAppOrigin(raw, development);
        if (!origin) return null;
        if (!seen.has(origin)) {
            seen.add(origin);
            normalized.push(origin);
        }
    }
    return normalized;
}

export function normalizeMcpAppResourceCsp(
    value: unknown,
    development: boolean,
): McpAppResourceCsp | null | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['connectDomains', 'resourceDomains', 'frameDomains'])) return null;
    const connectDomains = normalizeOriginArray(value.connectDomains, development);
    const resourceDomains = normalizeOriginArray(value.resourceDomains, development);
    const frameDomains = normalizeOriginArray(value.frameDomains, development);
    return connectDomains && resourceDomains && frameDomains
        ? { connectDomains, resourceDomains, frameDomains }
        : null;
}

function normalizePermissions(value: unknown): McpAppResourcePermissions | null | undefined {
    if (value === undefined) return undefined;
    const keys = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
    const permissions: McpAppResourcePermissions = {};
    for (const key of keys) {
        const marker = value[key];
        if (marker === undefined) continue;
        if (!isRecord(marker) || Object.keys(marker).length !== 0) return null;
        permissions[key] = {};
    }
    return permissions;
}

export function normalizeMcpAppResourceUi(
    value: unknown,
    development: boolean,
): McpAppResourceUi | null | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !hasOnlyKeys(value, ['csp', 'permissions', 'prefersBorder'])) return null;
    const csp = normalizeMcpAppResourceCsp(value.csp, development);
    const permissions = normalizePermissions(value.permissions);
    if (csp === null || permissions === null
        || (value.prefersBorder !== undefined && typeof value.prefersBorder !== 'boolean')) return null;
    const ui: McpAppResourceUi = {
        ...(csp ? { csp } : {}),
        ...(permissions ? { permissions } : {}),
        ...(value.prefersBorder !== undefined ? { prefersBorder: value.prefersBorder } : {}),
    };
    let serialized: string;
    try { serialized = JSON.stringify(ui); } catch { return null; }
    return byteLength(serialized) <= MCP_APP_MAX_UI_METADATA_BYTES ? ui : null;
}
