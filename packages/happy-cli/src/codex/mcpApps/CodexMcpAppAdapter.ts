/**
 * Lossless compatibility boundary between Codex MCP tool items and the
 * provider-neutral MCP App fields carried by Session Protocol events.
 */

import { Buffer } from 'node:buffer';
import {
    mcpAppPresentationV1Schema,
    type McpAppPresentationV1,
    type McpAppResultV1,
} from '@slopus/happy-wire';
import type { McpToolAnnotations, McpToolCatalogEntry, ThreadItem } from '../codexAppServerTypes';

const MAX_MCP_APP_RESULT_BYTES = 256 * 1024;

export type McpAppErrorCode =
    | 'MCP_APP_UNSUPPORTED'
    | 'MCP_APP_SESSION_OFFLINE'
    | 'MCP_APP_BINDING_NOT_FOUND'
    | 'MCP_APP_ORIGIN_MISMATCH'
    | 'MCP_APP_RESOURCE_NOT_FOUND'
    | 'MCP_APP_INVALID_RESOURCE'
    | 'MCP_APP_RESOURCE_TOO_LARGE'
    | 'MCP_APP_RESULT_TOO_LARGE'
    | 'MCP_APP_TOOL_NOT_ALLOWED'
    | 'MCP_APP_PERMISSION_DENIED'
    | 'MCP_APP_SANDBOX_UNAVAILABLE'
    | 'MCP_APP_BRIDGE_PROTOCOL'
    | 'MCP_APP_TIMEOUT'
    | 'MCP_APP_INTERNAL';

export type McpAppRpcResponse<T> =
    | { ok: true; value: T }
    | { ok: false; error: { code: McpAppErrorCode; retryable: boolean; summary: string } };

const MCP_APP_ERROR_CODES = new Set<McpAppErrorCode>([
    'MCP_APP_UNSUPPORTED', 'MCP_APP_SESSION_OFFLINE', 'MCP_APP_BINDING_NOT_FOUND',
    'MCP_APP_ORIGIN_MISMATCH', 'MCP_APP_RESOURCE_NOT_FOUND', 'MCP_APP_INVALID_RESOURCE',
    'MCP_APP_RESOURCE_TOO_LARGE', 'MCP_APP_RESULT_TOO_LARGE', 'MCP_APP_TOOL_NOT_ALLOWED',
    'MCP_APP_PERMISSION_DENIED', 'MCP_APP_SANDBOX_UNAVAILABLE', 'MCP_APP_BRIDGE_PROTOCOL',
    'MCP_APP_TIMEOUT', 'MCP_APP_INTERNAL',
]);

/** Converts legacy generic-RPC errors to the opaque App-safe envelope. */
export function normalizeMcpAppRpcResponse<T>(response: unknown): McpAppRpcResponse<T> {
    const internal = (): McpAppRpcResponse<T> => ({
        ok: false,
        error: { code: 'MCP_APP_INTERNAL', retryable: false, summary: 'The App request could not be completed.' },
    });
    if (!response || typeof response !== 'object' || Array.isArray(response)) return internal();
    const candidate = response as Record<string, unknown>;
    if (candidate.ok === true && 'value' in candidate) return { ok: true, value: candidate.value as T };
    const error = candidate.error;
    if (candidate.ok !== false || !error || typeof error !== 'object' || Array.isArray(error)) return internal();
    const safeError = error as Record<string, unknown>;
    if (typeof safeError.code !== 'string' || !MCP_APP_ERROR_CODES.has(safeError.code as McpAppErrorCode)
        || typeof safeError.retryable !== 'boolean' || typeof safeError.summary !== 'string') return internal();
    return {
        ok: false,
        error: {
            code: safeError.code as McpAppErrorCode,
            retryable: safeError.retryable,
            summary: safeError.summary,
        },
    };
}

function optionalDisplayName(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        ? value
        : undefined;
}

export interface NormalizedCodexMcpAppCall {
    callId: string;
    server: string;
    tool: string;
    input: Record<string, unknown>;
    connectorId?: string;
    presentation?: McpAppPresentationV1;
    result?: McpAppResultV1;
}

export type NormalizedMcpToolCatalogMatch = {
    entry: McpToolCatalogEntry;
    serverEnabled: boolean;
    toolEnabled: boolean;
    appVisible: boolean;
    annotations: McpToolAnnotations;
    connectorId?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function catalogServers(response: unknown): unknown[] {
    if (Array.isArray(response)) return response;
    const candidate = record(response);
    if (!candidate) return [];
    for (const key of ['data', 'servers', 'mcpServers']) {
        if (Array.isArray(candidate[key])) return candidate[key];
    }
    return [];
}

function catalogEntries(server: Record<string, unknown>): McpToolCatalogEntry[] {
    const tools = server.tools;
    if (Array.isArray(tools)) {
        return tools.filter((entry): entry is McpToolCatalogEntry => {
            const candidate = record(entry);
            return typeof candidate?.name === 'string' && candidate.name.length > 0;
        });
    }
    const toolRecord = record(tools);
    if (!toolRecord) return [];
    const entries: McpToolCatalogEntry[] = [];
    for (const [name, value] of Object.entries(toolRecord)) {
        const candidate = record(value);
        if (!candidate) continue;
        const normalizedName = typeof candidate.name === 'string' && candidate.name.length > 0
            ? candidate.name
            : name;
        entries.push({ ...candidate, name: normalizedName } as McpToolCatalogEntry);
    }
    return entries;
}

function hasOwn(candidate: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(candidate, key);
}

const MCP_RUNTIME_STATUSES = new Set([
    'notStarted',
    'starting',
    'connected',
    'authenticationRequired',
    'failed',
    'cancelled',
    'disabled',
]);

function normalizedServerEnabled(server: Record<string, unknown>): boolean | undefined {
    const hasRuntimeStatus = hasOwn(server, 'runtimeStatus');
    const hasDeprecatedStatus = hasOwn(server, 'status');
    if (!hasRuntimeStatus && !hasDeprecatedStatus) return true;

    const statuses = [
        ...(hasRuntimeStatus ? [server.runtimeStatus] : []),
        ...(hasDeprecatedStatus ? [server.status] : []),
    ];
    if (statuses.some((status) => status !== null
        && (typeof status !== 'string' || !MCP_RUNTIME_STATUSES.has(status)))) return undefined;
    if (statuses.length === 2 && statuses[0] !== statuses[1]) return undefined;
    return statuses[0] === 'connected';
}

function normalizedVisibility(value: unknown): ReadonlySet<'app' | 'model'> | undefined {
    if (!Array.isArray(value) || value.some((entry) => entry !== 'app' && entry !== 'model')) {
        return undefined;
    }
    return new Set(value as Array<'app' | 'model'>);
}

function sameVisibility(
    left: ReadonlySet<'app' | 'model'>,
    right: ReadonlySet<'app' | 'model'>,
): boolean {
    return left.size === right.size && [...left].every((entry) => right.has(entry));
}

type NormalizedCatalogControls = {
    toolEnabled: boolean;
    appVisible: boolean;
    annotations: McpToolAnnotations;
    connectorId?: string;
};

function normalizedCatalogControls(entry: McpToolCatalogEntry): NormalizedCatalogControls | undefined {
    const rawEntry = entry as Record<string, unknown>;
    const toolEnabled = hasOwn(rawEntry, 'enabled')
        ? typeof rawEntry.enabled === 'boolean' ? rawEntry.enabled : undefined
        : true;
    if (toolEnabled === undefined) return undefined;

    const hasAnnotations = hasOwn(rawEntry, 'annotations');
    const rawAnnotations = rawEntry.annotations;
    const annotations = hasAnnotations ? record(rawAnnotations) : {};
    if (!annotations) return undefined;
    for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        if (hasOwn(annotations, key) && typeof annotations[key] !== 'boolean') return undefined;
    }

    const hasMeta = hasOwn(rawEntry, '_meta');
    const rawMeta = rawEntry._meta;
    const meta = hasMeta ? record(rawMeta) : undefined;
    if (hasMeta && !meta) return undefined;
    const hasUi = !!meta && hasOwn(meta, 'ui');
    const rawUi = meta?.ui;
    const ui = hasUi ? record(rawUi) : undefined;
    if (hasUi && !ui) return undefined;

    const hasCurrentVisibility = !!ui && hasOwn(ui, 'visibility');
    const hasDeprecatedVisibility = !!meta && hasOwn(meta, 'ui/visibility');
    const currentVisibility = hasCurrentVisibility ? normalizedVisibility(ui!.visibility) : undefined;
    const deprecatedVisibility = hasDeprecatedVisibility
        ? normalizedVisibility(meta!['ui/visibility'])
        : undefined;
    if ((hasCurrentVisibility && !currentVisibility)
        || (hasDeprecatedVisibility && !deprecatedVisibility)
        || (currentVisibility && deprecatedVisibility
            && !sameVisibility(currentVisibility, deprecatedVisibility))) return undefined;
    const visibility = currentVisibility ?? deprecatedVisibility;

    const hasMetaConnector = !!meta && hasOwn(meta, 'connectorId');
    const hasUiConnector = !!ui && hasOwn(ui, 'connectorId');
    const connectorValues = [
        ...(hasMetaConnector ? [meta!.connectorId] : []),
        ...(hasUiConnector ? [ui!.connectorId] : []),
    ];
    if (connectorValues.some((value) => typeof value !== 'string'
        || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256)) return undefined;
    if (connectorValues.length === 2 && connectorValues[0] !== connectorValues[1]) return undefined;
    const connectorId = connectorValues[0] as string | undefined;

    return {
        toolEnabled,
        appVisible: visibility === undefined || visibility.has('app'),
        annotations: annotations as McpToolAnnotations,
        ...(connectorId ? { connectorId } : {}),
    };
}

export class CodexMcpAppAdapter {
    findCatalogTool(
        response: unknown,
        serverName: string,
        toolName: string,
    ): NormalizedMcpToolCatalogMatch | undefined {
        const servers = catalogServers(response)
            .map(record)
            .filter((candidate): candidate is Record<string, unknown> => candidate !== undefined
                && (candidate.name === serverName || candidate.serverName === serverName));
        if (servers.length !== 1) return undefined;
        const server = servers[0];
        const entries = catalogEntries(server).filter((candidate) => candidate.name === toolName);
        if (entries.length !== 1) return undefined;
        const entry = entries[0];
        const serverEnabled = normalizedServerEnabled(server);
        const controls = normalizedCatalogControls(entry);
        if (serverEnabled === undefined || !controls) return undefined;
        return {
            entry,
            serverEnabled,
            ...controls,
        };
    }

    normalizeItem(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): NormalizedCodexMcpAppCall {
        const input = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
            ? item.arguments as Record<string, unknown>
            : {};
        const normalized: NormalizedCodexMcpAppCall = {
            callId: item.id,
            server: item.server,
            tool: item.tool,
            input,
        };

        const resourceUri = item.appContext?.resourceUri
            ?? item.appContext?.resource_uri
            ?? item.mcpAppResourceUri;
        const appName = optionalDisplayName(item.appContext?.appName, 160);
        const actionName = optionalDisplayName(item.appContext?.actionName, 160);
        const connectorId = typeof item.appContext?.connectorId === 'string'
            && item.appContext.connectorId.length > 0
            ? item.appContext.connectorId
            : undefined;
        const presentationCandidate = {
            version: 1 as const,
            server: item.server,
            resourceUri,
            ...(appName ? { appName } : {}),
            ...(actionName ? { actionName } : {}),
        };
        const parsedPresentation = mcpAppPresentationV1Schema.safeParse(presentationCandidate);
        if (!parsedPresentation.success) {
            return normalized;
        }

        if (connectorId) {
            normalized.connectorId = connectorId;
        }
        normalized.presentation = parsedPresentation.data;
        const rawResult = item.result;
        if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
            return normalized;
        }

        const candidate: McpAppResultV1 = {
            version: 1,
            state: 'available',
            content: Array.isArray(rawResult.content) ? rawResult.content : [],
            ...(rawResult.structuredContent !== undefined
                ? { structuredContent: rawResult.structuredContent }
                : {}),
            ...(rawResult._meta !== null && typeof rawResult._meta === 'object' && !Array.isArray(rawResult._meta)
                ? { _meta: rawResult._meta }
                : {}),
        };
        const serializedCandidate = JSON.stringify(candidate);
        normalized.result = Buffer.byteLength(serializedCandidate, 'utf8') > MAX_MCP_APP_RESULT_BYTES
            ? { version: 1, state: 'unavailable', code: 'MCP_APP_RESULT_TOO_LARGE' }
            : candidate;

        return normalized;
    }
}
