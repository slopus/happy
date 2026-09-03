import { z } from 'zod';

export const MCP_APP_SANDBOX_MAX_CSP_BYTES = 8 * 1024;
export const MCP_APP_SANDBOX_MAX_CSP_ORIGINS = 32;

const cspMetadataSchema = z.object({
    connectDomains: z.array(z.string()).max(MCP_APP_SANDBOX_MAX_CSP_ORIGINS),
    resourceDomains: z.array(z.string()).max(MCP_APP_SANDBOX_MAX_CSP_ORIGINS),
    frameDomains: z.array(z.string()).max(MCP_APP_SANDBOX_MAX_CSP_ORIGINS),
}).strict();

export interface SandboxCspMetadata {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
}

interface ResolveSandboxRequestInput {
    requestHost: string | undefined;
    parentOrigin: string | undefined;
    sandboxOrigin: string | undefined;
    allowedParentOrigins: readonly string[];
    development: boolean;
}

export type ResolvedSandboxRequest = {
    ok: true;
    sandboxOrigin: string;
    parentOrigin: string;
} | { ok: false };

function isLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function hasCanonicalDevelopmentHttpAuthority(raw: string): boolean {
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/u.exec(raw);
    if (!match) return false;
    return match[1] === undefined || Number(match[1]) <= 65_535;
}

function hasCanonicalDevelopmentHttpHost(raw: string): boolean {
    const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/u.exec(raw);
    if (!match) return false;
    return match[1] === undefined || Number(match[1]) <= 65_535;
}

export function normalizeSandboxOrigin(raw: string, development: boolean): string | null {
    if (!raw || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) return null;
    const withoutRootSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const schemeSeparator = withoutRootSlash.indexOf('://');
    if (schemeSeparator <= 0 || withoutRootSlash.slice(schemeSeparator + 3).includes('/')) return null;

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (!url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) return null;
    if (url.protocol !== 'https:') {
        if (url.protocol !== 'http:' || !development || !isLoopbackHostname(url.hostname)
            || !hasCanonicalDevelopmentHttpAuthority(raw)) return null;
    }
    if (url.origin === 'null') return null;
    return url.origin;
}

function normalizeRequestHost(raw: string, protocol: 'http:' | 'https:'): string | null {
    if (!raw || raw.trim() !== raw || /[\s,@/\\?#]/u.test(raw)) return null;
    if (protocol === 'http:' && !hasCanonicalDevelopmentHttpHost(raw)) return null;
    try {
        const url = new URL(`${protocol}//${raw}`);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        return url.host;
    } catch {
        return null;
    }
}

function normalizeOriginArray(values: readonly string[], development: boolean): string[] | null {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const origin = normalizeSandboxOrigin(value, development);
        if (!origin) return null;
        if (!seen.has(origin)) {
            seen.add(origin);
            normalized.push(origin);
        }
    }
    return normalized;
}

export function parseSandboxOriginList(raw: string | undefined, development: boolean): string[] | null {
    if (raw === undefined || raw.trim() === '') return [];
    const entries = raw.split(',').map((entry) => entry.trim());
    if (entries.some((entry) => entry === '')) return null;
    return normalizeOriginArray(entries, development);
}

export function resolveSandboxRequest(input: ResolveSandboxRequestInput): ResolvedSandboxRequest {
    if (!input.sandboxOrigin || !input.parentOrigin || !input.requestHost) return { ok: false };
    const sandboxOrigin = normalizeSandboxOrigin(input.sandboxOrigin, input.development);
    const parentOrigin = normalizeSandboxOrigin(input.parentOrigin, input.development);
    const allowedParentOrigins = normalizeOriginArray(input.allowedParentOrigins, input.development);
    if (!sandboxOrigin || !parentOrigin || !allowedParentOrigins?.length) return { ok: false };

    const sandboxUrl = new URL(sandboxOrigin);
    const requestHost = normalizeRequestHost(input.requestHost, sandboxUrl.protocol as 'http:' | 'https:');
    if (requestHost !== sandboxUrl.host || allowedParentOrigins.includes(sandboxOrigin)
        || !allowedParentOrigins.includes(parentOrigin)) return { ok: false };
    return { ok: true, sandboxOrigin, parentOrigin };
}

function normalizeCspMetadata(input: unknown, development: boolean): SandboxCspMetadata | null {
    const parsed = cspMetadataSchema.safeParse(input);
    if (!parsed.success) return null;
    const connectDomains = normalizeOriginArray(parsed.data.connectDomains, development);
    const resourceDomains = normalizeOriginArray(parsed.data.resourceDomains, development);
    const frameDomains = normalizeOriginArray(parsed.data.frameDomains, development);
    if (!connectDomains || !resourceDomains || !frameDomains) return null;
    return { connectDomains, resourceDomains, frameDomains };
}

export function encodeSandboxCspMetadata(input: unknown, development: boolean): string | null {
    const metadata = normalizeCspMetadata(input, development);
    if (!metadata) return null;
    const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
    return Buffer.byteLength(encoded, 'utf8') <= MCP_APP_SANDBOX_MAX_CSP_BYTES ? encoded : null;
}

export function parseSandboxCspMetadata(encoded: string | undefined, development: boolean): SandboxCspMetadata | null {
    if (!encoded || Buffer.byteLength(encoded, 'utf8') > MCP_APP_SANDBOX_MAX_CSP_BYTES
        || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
    let decoded: string;
    try {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) return null;
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(decoded);
    } catch {
        return null;
    }
    const metadata = normalizeCspMetadata(raw, development);
    if (!metadata || encodeSandboxCspMetadata(metadata, development) !== encoded) return null;
    return metadata;
}
