import { createHash, randomBytes } from 'node:crypto';
import { logger } from '@/ui/logger';
import type {
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    McpResourceReadParams,
    McpResourceReadResponse,
    McpServerToolCallParams,
    McpServerToolCallResponse,
} from '../codexAppServerTypes';
import { CodexAppServerRequestTimeoutError } from '../codexAppServerClient';
import { CodexMcpAppAdapter, type McpAppErrorCode, type McpAppRpcResponse } from './CodexMcpAppAdapter';
import type { McpAppBindingRegistry } from './McpAppBindingRegistry';
import type { PermissionResult } from '../utils/permissionHandler';
import {
    emitMcpAppTelemetry,
    type McpAppTelemetrySink,
    type McpAppTelemetryOutcomeCode,
} from './mcpAppTelemetry';

export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MCP_APP_CHUNK_BYTES = 256 * 1024;
export const MCP_APP_MAX_ACTIVE_RESOURCES = 8;
export const MCP_APP_RESOURCE_TTL_MS = 2 * 60 * 1000;
export const MCP_APP_MAX_SECONDARY_RESOURCE_BYTES = 512 * 1024;
export const MCP_APP_MAX_TOOL_PAYLOAD_BYTES = 256 * 1024;
export const MCP_APP_MAX_JSON_DEPTH = 32;
export const MCP_APP_MAX_CONCURRENT_OPERATIONS = 8;
export const MCP_APP_OPERATION_TIMEOUT_MS = 30_000;
export const MCP_APP_MAX_CALL_ID_BYTES = 256;
export const MCP_APP_MAX_TOOL_NAME_BYTES = 256;
export const MCP_APP_MAX_OPERATION_ID_BYTES = 128;
export const MCP_APP_MAX_UI_METADATA_BYTES = 16 * 1024;
export const MCP_APP_MAX_CSP_ORIGINS = 32;
const MCP_APP_MAX_PRE_CANCEL_TOMBSTONES = 64;
const MCP_APP_PRE_CANCEL_TTL_MS = MCP_APP_OPERATION_TIMEOUT_MS;

export type McpAppResourceOpenRequest = {
    callId: string;
};

export type McpAppResourceOpenResponse = {
    resourceId: string;
    uri: string;
    mimeType: 'text/html;profile=mcp-app';
    byteLength: number;
    sha256: string;
    encoding: 'utf8';
    ui?: McpAppResourceUi;
};

export type McpAppResourceCsp = {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
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

export type McpAppResourceChunkRequest = {
    resourceId: string;
    offset: number;
};

export type McpAppResourceChunkResponse = {
    offset: number;
    dataBase64: string;
    nextOffset?: number;
};

export type McpAppResourceReadRequest = {
    callId: string;
    operationId: string;
    uri: string;
};

export type McpAppToolCallRequest = {
    callId: string;
    operationId: string;
    tool: string;
    arguments?: Record<string, unknown>;
    _meta?: unknown;
};

export type McpAppOperationCancelRequest = {
    callId: string;
    operationId: string;
};

export type { McpAppRpcResponse } from './CodexMcpAppAdapter';

type BufferedResource = {
    resourceId: string;
    callId: string;
    bytes: Uint8Array;
    sha256: string;
    expiresAt: number;
    ui?: McpAppResourceUi;
};

export type McpAppRpcHandlerManager = {
    registerHandler(method: string, handler: (request: any) => any): void;
    unregisterHandler(method: string): void;
};

type McpResourceClient = {
    readMcpResource(
        params: McpResourceReadParams,
        options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<McpResourceReadResponse>;
    listMcpServerStatus(
        params: ListMcpServerStatusParams,
        options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<ListMcpServerStatusResponse>;
    callMcpTool(
        params: McpServerToolCallParams,
        options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<McpServerToolCallResponse>;
};

type McpAppPermissionHandler = {
    handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: { signal?: AbortSignal },
    ): Promise<PermissionResult>;
};

const summaries: Record<McpAppErrorCode, string> = {
    MCP_APP_UNSUPPORTED: 'This App is not supported.',
    MCP_APP_SESSION_OFFLINE: 'The session is no longer available.',
    MCP_APP_BINDING_NOT_FOUND: 'This App resource is no longer available.',
    MCP_APP_ORIGIN_MISMATCH: 'Waiting for the trusted App origin.',
    MCP_APP_RESOURCE_NOT_FOUND: 'The App resource was not found.',
    MCP_APP_INVALID_RESOURCE: 'The App resource is invalid.',
    MCP_APP_RESOURCE_TOO_LARGE: 'The App resource is too large.',
    MCP_APP_RESULT_TOO_LARGE: 'The App result is too large.',
    MCP_APP_TOOL_NOT_ALLOWED: 'This App action is not allowed.',
    MCP_APP_PERMISSION_DENIED: 'Permission was denied.',
    MCP_APP_SANDBOX_UNAVAILABLE: 'The App sandbox is unavailable.',
    MCP_APP_BRIDGE_PROTOCOL: 'The App bridge protocol failed.',
    MCP_APP_TIMEOUT: 'The App request timed out.',
    MCP_APP_INTERNAL: 'The App resource could not be loaded.',
};

function failure<T>(code: McpAppErrorCode, retryable: boolean): McpAppRpcResponse<T> {
    logger.debug(`[McpAppRpc] ${code}`);
    return { ok: false, error: { code, retryable, summary: summaries[code] } };
}

function validOpenRequest(request: unknown): request is McpAppResourceOpenRequest {
    const candidate = request && typeof request === 'object'
        ? request as Record<string, unknown>
        : undefined;
    return typeof candidate?.callId === 'string' && candidate.callId.length > 0;
}

function validChunkRequest(request: unknown): request is McpAppResourceChunkRequest {
    const candidate = request && typeof request === 'object'
        ? request as Record<string, unknown>
        : undefined;
    return typeof candidate?.resourceId === 'string' && candidate.resourceId.length > 0
        && Number.isInteger(candidate.offset) && (candidate.offset as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(candidate: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(candidate).every((key) => allowed.has(key));
}

function validResourceReadRequest(request: unknown): request is McpAppResourceReadRequest {
    if (!isRecord(request) || !hasOnlyKeys(request, new Set(['callId', 'operationId', 'uri']))) return false;
    return typeof request.callId === 'string' && request.callId.length > 0
        && validOperationId(request.operationId)
        && typeof request.uri === 'string' && request.uri.length > 0 && request.uri.length <= 8_192;
}

function validOperationId(value: unknown): value is string {
    return typeof value === 'string'
        && Buffer.byteLength(value, 'utf8') <= MCP_APP_MAX_OPERATION_ID_BYTES
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validCancelRequest(request: unknown): request is McpAppOperationCancelRequest {
    return isRecord(request)
        && hasOnlyKeys(request, new Set(['callId', 'operationId']))
        && typeof request.callId === 'string'
        && request.callId.length > 0
        && Buffer.byteLength(request.callId, 'utf8') <= MCP_APP_MAX_CALL_ID_BYTES
        && validOperationId(request.operationId);
}

function jsonDepthWithin(value: unknown, maxDepth: number): boolean {
    const seen = new Set<object>();
    const visit = (candidate: unknown, depth: number): boolean => {
        if (depth > maxDepth) return false;
        if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
        if (typeof candidate === 'number') return Number.isFinite(candidate);
        if (typeof candidate !== 'object') return false;
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        const valid = Array.isArray(candidate)
            ? candidate.every((entry) => visit(entry, depth + 1))
            : (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null)
                && Object.values(candidate).every((entry) => visit(entry, depth + 1));
        seen.delete(candidate);
        return valid;
    };
    return visit(value, 0);
}

function serializedBytes(value: unknown): number | null {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
    } catch {
        return null;
    }
}

function jsonWithinBounds(value: unknown, maxBytes: number): boolean {
    if (!jsonDepthWithin(value, MCP_APP_MAX_JSON_DEPTH)) return false;
    const bytes = serializedBytes(value);
    return bytes !== null && bytes <= maxBytes;
}

function validToolCallRequest(request: unknown): request is McpAppToolCallRequest {
    if (!isRecord(request)
        || !hasOnlyKeys(request, new Set(['callId', 'operationId', 'tool', 'arguments', '_meta']))) return false;
    if (typeof request.callId !== 'string' || request.callId.length === 0
        || Buffer.byteLength(request.callId, 'utf8') > MCP_APP_MAX_CALL_ID_BYTES
        || !validOperationId(request.operationId)
        || typeof request.tool !== 'string' || request.tool.length === 0
        || Buffer.byteLength(request.tool, 'utf8') > MCP_APP_MAX_TOOL_NAME_BYTES) return false;
    if (request.arguments !== undefined && !isRecord(request.arguments)) return false;
    return jsonWithinBounds(request, MCP_APP_MAX_TOOL_PAYLOAD_BYTES);
}

function uriScheme(uri: string): string | undefined {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(uri);
    return match?.[1]?.toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalDevelopmentHttp(raw: string): boolean {
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/u.exec(raw);
    return Boolean(match && (match[1] === undefined || Number(match[1]) <= 65_535));
}

function normalizeExactResourceOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2_048
        || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) return null;
    const withoutRootSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const separator = withoutRootSlash.indexOf('://');
    if (separator <= 0 || withoutRootSlash.slice(separator + 3).includes('/')) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || !url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) return null;
    if (url.protocol !== 'https:' && (url.protocol !== 'http:'
        || !isLoopbackHostname(url.hostname) || !canonicalDevelopmentHttp(raw))) return null;
    return url.origin === 'null' ? null : url.origin;
}

function normalizeOriginArray(value: unknown): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MCP_APP_MAX_CSP_ORIGINS) return null;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        const origin = normalizeExactResourceOrigin(raw);
        if (!origin) return null;
        if (!seen.has(origin)) {
            seen.add(origin);
            normalized.push(origin);
        }
    }
    return normalized;
}

function normalizeResourceCsp(value: unknown): McpAppResourceCsp | null | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)
        || !hasOnlyKeys(value, new Set(['connectDomains', 'resourceDomains', 'frameDomains']))) return null;
    const connectDomains = normalizeOriginArray(value.connectDomains);
    const resourceDomains = normalizeOriginArray(value.resourceDomains);
    const frameDomains = normalizeOriginArray(value.frameDomains);
    return connectDomains && resourceDomains && frameDomains
        ? { connectDomains, resourceDomains, frameDomains }
        : null;
}

function normalizeResourcePermissions(value: unknown): McpAppResourcePermissions | null | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)
        || !hasOnlyKeys(value, new Set(['camera', 'microphone', 'geolocation', 'clipboardWrite']))) return null;
    const permissions: McpAppResourcePermissions = {};
    for (const key of ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const) {
        const marker = value[key];
        if (marker === undefined) continue;
        if (!isRecord(marker) || Object.keys(marker).length !== 0) return null;
        permissions[key] = {};
    }
    return permissions;
}

function normalizePrimaryResourceUi(content: Record<string, unknown>): McpAppResourceUi | null | undefined {
    const meta = isRecord(content._meta) ? content._meta : undefined;
    if (!meta) return undefined;
    if (meta.ui !== undefined && !isRecord(meta.ui)) return null;
    const modern = isRecord(meta.ui) ? meta.ui : undefined;
    const csp = normalizeResourceCsp(modern && Object.hasOwn(modern, 'csp')
        ? modern.csp
        : meta['ui/csp']);
    const permissions = normalizeResourcePermissions(modern && Object.hasOwn(modern, 'permissions')
        ? modern.permissions
        : meta['ui/permissions']);
    const prefersBorder = modern && Object.hasOwn(modern, 'prefersBorder')
        ? modern.prefersBorder
        : meta['ui/prefersBorder'];
    if (csp === null || permissions === null
        || (prefersBorder !== undefined && typeof prefersBorder !== 'boolean')) return null;
    const ui: McpAppResourceUi = {
        ...(csp ? { csp } : {}),
        ...(permissions ? { permissions } : {}),
        ...(prefersBorder !== undefined ? { prefersBorder } : {}),
    };
    if (Object.keys(ui).length === 0) return undefined;
    return jsonWithinBounds(ui, MCP_APP_MAX_UI_METADATA_BYTES) ? ui : null;
}

function declaredPrimaryResourceSchemes(ui: McpAppResourceUi | undefined): ReadonlySet<string> {
    const schemes = new Set<string>(['ui']);
    for (const domain of ui?.csp?.resourceDomains ?? []) {
        const scheme = uriScheme(domain);
        if (scheme === 'http' || scheme === 'https') schemes.add(scheme);
    }
    return schemes;
}

type PrimaryResource = {
    bytes: Uint8Array;
    allowedSecondarySchemes: ReadonlySet<string>;
    ui?: McpAppResourceUi;
};

function primaryResourceBytes(
    response: unknown,
    expectedUri: string,
): PrimaryResource | null {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        return null;
    }
    const typedResponse = response as McpResourceReadResponse;
    if (!Array.isArray(typedResponse.contents) || typedResponse.contents.length !== 1) {
        return null;
    }
    const content = typedResponse.contents[0];
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return null;
    }
    if (content.uri !== expectedUri || content.mimeType !== 'text/html;profile=mcp-app') {
        return null;
    }
    const ui = normalizePrimaryResourceUi(content as Record<string, unknown>);
    if (ui === null) return null;
    if (typeof content.text === 'string' && content.blob === undefined) {
        return {
            bytes: Buffer.from(content.text, 'utf8'),
            allowedSecondarySchemes: declaredPrimaryResourceSchemes(ui),
            ...(ui ? { ui } : {}),
        };
    }
    if (typeof content.blob === 'string' && content.text === undefined) {
        const bytes = Buffer.from(content.blob, 'base64');
        return bytes.byteLength > 0 || content.blob.length === 0
            ? {
                bytes,
                allowedSecondarySchemes: declaredPrimaryResourceSchemes(ui),
                ...(ui ? { ui } : {}),
            }
            : null;
    }
    return null;
}

type SafeResourceResult =
    | { ok: true; value: McpResourceReadResponse }
    | { ok: false; tooLarge: boolean };

function safeSecondaryResourceResult(response: unknown, expectedUri: string): SafeResourceResult {
    if (!isRecord(response) || !Array.isArray(response.contents) || response.contents.length === 0) {
        return { ok: false, tooLarge: false };
    }
    const contents: McpResourceReadResponse['contents'] = [];
    for (const item of response.contents) {
        if (!isRecord(item) || item.uri !== expectedUri
            || (item.mimeType !== undefined && typeof item.mimeType !== 'string')) {
            return { ok: false, tooLarge: false };
        }
        const text = typeof item.text === 'string' ? item.text : undefined;
        const blob = typeof item.blob === 'string' ? item.blob : undefined;
        if ((text === undefined) === (blob === undefined)) return { ok: false, tooLarge: false };
        contents.push({
            uri: expectedUri,
            ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
            ...(text !== undefined ? { text } : { blob: blob! }),
            ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        });
    }
    const value: McpResourceReadResponse = { contents };
    if (!jsonDepthWithin(value, MCP_APP_MAX_JSON_DEPTH)) return { ok: false, tooLarge: true };
    const bytes = serializedBytes(value);
    if (bytes === null) return { ok: false, tooLarge: false };
    if (bytes > MCP_APP_MAX_SECONDARY_RESOURCE_BYTES) return { ok: false, tooLarge: true };
    return { ok: true, value };
}

type SafeToolResult =
    | { ok: true; value: McpServerToolCallResponse }
    | { ok: false; tooLarge: boolean };

function safeToolResult(response: unknown): SafeToolResult {
    if (!isRecord(response) || !Array.isArray(response.content)
        || (response.isError !== undefined && typeof response.isError !== 'boolean')) {
        return { ok: false, tooLarge: false };
    }
    const value: McpServerToolCallResponse = {
        content: response.content,
        ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}),
        ...(response.isError !== undefined ? { isError: response.isError } : {}),
        ...(isRecord(response._meta) ? { _meta: response._meta } : {}),
    };
    if (!jsonDepthWithin(value, MCP_APP_MAX_JSON_DEPTH)) return { ok: false, tooLarge: true };
    const bytes = serializedBytes(value);
    if (bytes === null) return { ok: false, tooLarge: false };
    if (bytes > MCP_APP_MAX_TOOL_PAYLOAD_BYTES) return { ok: false, tooLarge: true };
    return { ok: true, value };
}

type ActiveOperation = {
    controller: AbortController;
    deadlineAt: number;
    epoch: number;
    interactiveKey?: string;
    timedOut: boolean;
    cancelled: boolean;
    timeout: ReturnType<typeof setTimeout>;
};

class McpAppOperationInterrupted extends Error {
    constructor() {
        super('MCP App operation interrupted');
        this.name = 'McpAppOperationInterrupted';
    }
}

function requestConnectorMatches(requestMeta: unknown, connectorId: string | undefined): boolean {
    if (!isRecord(requestMeta) || requestMeta.connectorId === undefined) return true;
    return typeof requestMeta.connectorId === 'string' && requestMeta.connectorId === connectorId;
}

export function registerMcpAppRpcHandlers(options: {
    rpcHandlerManager: McpAppRpcHandlerManager;
    client: McpResourceClient;
    bindingRegistry: McpAppBindingRegistry;
    permissionHandler: McpAppPermissionHandler;
    now?: () => number;
    telemetry?: McpAppTelemetrySink;
}) {
    const now = options.now ?? (() => Date.now());
    const adapter = new CodexMcpAppAdapter();
    const resources = new Map<string, BufferedResource>();
    const allowedSecondarySchemes = new Map<string, ReadonlySet<string>>();
    const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlightOperations = new Set<ActiveOperation>();
    const interactiveOperations = new Map<string, ActiveOperation>();
    const preCancelledOperations = new Map<string, number>();
    let preCancelExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    let rpcHandlerManager = options.rpcHandlerManager;
    let disposed = false;
    let requestSequence = 0;
    let operationEpoch = 0;

    const removeResource = (resourceId: string): void => {
        const timer = expiryTimers.get(resourceId);
        if (timer) clearTimeout(timer);
        expiryTimers.delete(resourceId);
        resources.delete(resourceId);
    };
    const scheduleExpiry = (resource: BufferedResource): void => {
        const previous = expiryTimers.get(resource.resourceId);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => {
            const current = resources.get(resource.resourceId);
            if (!current) return;
            if (current.expiresAt <= now()) {
                removeResource(current.resourceId);
                return;
            }
            scheduleExpiry(current);
        }, Math.max(0, resource.expiresAt - now()));
        timer.unref?.();
        expiryTimers.set(resource.resourceId, timer);
    };
    const clearBufferedResources = (): void => {
        for (const resourceId of [...resources.keys()]) removeResource(resourceId);
        allowedSecondarySchemes.clear();
    };
    const expireOperation = (operation: ActiveOperation): void => {
        if (operation.timedOut || operation.controller.signal.aborted) return;
        operation.timedOut = true;
        operation.controller.abort();
    };
    const schedulePreCancelExpiry = (): void => {
        if (preCancelExpiryTimer) clearTimeout(preCancelExpiryTimer);
        preCancelExpiryTimer = undefined;
        const earliestExpiry = preCancelledOperations.values().next().value as number | undefined;
        if (earliestExpiry === undefined) return;
        preCancelExpiryTimer = setTimeout(() => {
            preCancelExpiryTimer = undefined;
            const currentTime = Date.now();
            for (const [key, expiresAt] of preCancelledOperations) {
                if (expiresAt > currentTime) break;
                preCancelledOperations.delete(key);
            }
            schedulePreCancelExpiry();
        }, Math.max(0, earliestExpiry - Date.now()));
        preCancelExpiryTimer.unref?.();
    };
    const prunePreCancelledOperations = (): void => {
        const currentTime = Date.now();
        let changed = false;
        for (const [key, expiresAt] of preCancelledOperations) {
            if (expiresAt > currentTime) break;
            preCancelledOperations.delete(key);
            changed = true;
        }
        if (changed) schedulePreCancelExpiry();
    };
    const clearPreCancelledOperations = (): void => {
        if (preCancelExpiryTimer) clearTimeout(preCancelExpiryTimer);
        preCancelExpiryTimer = undefined;
        preCancelledOperations.clear();
    };
    const rememberPreCancelledOperation = (key: string): void => {
        prunePreCancelledOperations();
        if (preCancelledOperations.has(key)) return;
        while (preCancelledOperations.size >= MCP_APP_MAX_PRE_CANCEL_TOMBSTONES) {
            const oldest = preCancelledOperations.keys().next().value as string | undefined;
            if (!oldest) break;
            preCancelledOperations.delete(oldest);
        }
        preCancelledOperations.set(key, Date.now() + MCP_APP_PRE_CANCEL_TTL_MS);
        schedulePreCancelExpiry();
    };
    const consumePreCancelledOperation = (key: string): boolean => {
        prunePreCancelledOperations();
        if (!preCancelledOperations.delete(key)) return false;
        schedulePreCancelExpiry();
        return true;
    };
    const abortInFlightOperations = (): void => {
        operationEpoch += 1;
        for (const operation of inFlightOperations) operation.controller.abort();
        interactiveOperations.clear();
        clearPreCancelledOperations();
    };
    const interactiveKey = (callId: string, operationId: string): string => (
        JSON.stringify([callId, operationId])
    );
    const beginOperation = (
        identity?: { callId: string; operationId: string },
    ): ActiveOperation | undefined => {
        if (inFlightOperations.size >= MCP_APP_MAX_CONCURRENT_OPERATIONS) return undefined;
        const ownedKey = identity ? interactiveKey(identity.callId, identity.operationId) : undefined;
        if (ownedKey && interactiveOperations.has(ownedKey)) return undefined;
        const controller = new AbortController();
        const operation = {
            controller,
            deadlineAt: Date.now() + MCP_APP_OPERATION_TIMEOUT_MS,
            epoch: operationEpoch,
            ...(ownedKey ? { interactiveKey: ownedKey } : {}),
            timedOut: false,
            cancelled: false,
            timeout: undefined as unknown as ReturnType<typeof setTimeout>,
        };
        operation.timeout = setTimeout(() => {
            expireOperation(operation);
        }, MCP_APP_OPERATION_TIMEOUT_MS);
        operation.timeout.unref?.();
        inFlightOperations.add(operation);
        if (ownedKey) interactiveOperations.set(ownedKey, operation);
        return operation;
    };
    const endOperation = (operation: ActiveOperation): void => {
        clearTimeout(operation.timeout);
        inFlightOperations.delete(operation);
        if (operation.interactiveKey
            && interactiveOperations.get(operation.interactiveKey) === operation) {
            interactiveOperations.delete(operation.interactiveKey);
        }
    };
    const operationIsCurrent = (operation: ActiveOperation): boolean => {
        if (disposed || operation.epoch !== operationEpoch
            || !inFlightOperations.has(operation) || operation.controller.signal.aborted) return false;
        if (Date.now() >= operation.deadlineAt) {
            expireOperation(operation);
            return false;
        }
        return true;
    };
    const ensureOperationIsCurrent = (operation: ActiveOperation): void => {
        if (!operationIsCurrent(operation)) throw new McpAppOperationInterrupted();
    };
    const remainingOperationMs = (operation: ActiveOperation): number => {
        ensureOperationIsCurrent(operation);
        const remaining = operation.deadlineAt - Date.now();
        if (remaining <= 0) {
            expireOperation(operation);
            throw new McpAppOperationInterrupted();
        }
        return remaining;
    };
    const awaitOperation = <T>(operation: ActiveOperation, promise: Promise<T>): Promise<T> => {
        ensureOperationIsCurrent(operation);
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new McpAppOperationInterrupted());
            operation.controller.signal.addEventListener('abort', onAbort, { once: true });
            const cleanup = () => operation.controller.signal.removeEventListener('abort', onAbort);
            promise.then(
                (value) => {
                    cleanup();
                    try {
                        ensureOperationIsCurrent(operation);
                        resolve(value);
                    } catch (error) {
                        reject(error);
                    }
                },
                (error) => {
                    cleanup();
                    reject(error);
                },
            );
        });
    };
    const operationFailure = <T>(operation: ActiveOperation, error: unknown): McpAppRpcResponse<T> => {
        if (operation.timedOut || error instanceof CodexAppServerRequestTimeoutError) {
            return failure('MCP_APP_TIMEOUT', true);
        }
        if (disposed || operation.epoch !== operationEpoch || operation.controller.signal.aborted) {
            return failure('MCP_APP_SESSION_OFFLINE', true);
        }
        return failure('MCP_APP_INTERNAL', true);
    };

    const resourceOpen = async (request: unknown): Promise<McpAppRpcResponse<McpAppResourceOpenResponse>> => {
        try {
            if (disposed) return failure('MCP_APP_SESSION_OFFLINE', true);
            if (!validOpenRequest(request)) return failure('MCP_APP_BINDING_NOT_FOUND', false);
            if (!options.bindingRegistry.has(request.callId)) return failure('MCP_APP_BINDING_NOT_FOUND', false);

        const binding = options.bindingRegistry.get(request.callId);
        if (binding.connectorId && !binding.trustedOriginCallId) {
            return failure('MCP_APP_ORIGIN_MISMATCH', true);
        }

        const params: McpResourceReadParams = {
            threadId: binding.threadId,
            server: binding.server,
            uri: binding.resourceUri,
            ...(binding.trustedOriginCallId ? { originCallId: request.callId } : {}),
        };

        const operation = beginOperation();
        if (!operation) return failure('MCP_APP_TIMEOUT', true);
        try {
            const response = await awaitOperation(operation, options.client.readMcpResource(params, {
                signal: operation.controller.signal,
                timeoutMs: remainingOperationMs(operation),
            }));

            const primary = primaryResourceBytes(response, binding.resourceUri);
            if (!primary) return failure('MCP_APP_INVALID_RESOURCE', false);
            if (primary.bytes.byteLength > MCP_APP_MAX_HTML_BYTES) {
                return failure('MCP_APP_RESOURCE_TOO_LARGE', false);
            }
            ensureOperationIsCurrent(operation);
            allowedSecondarySchemes.set(binding.callId, primary.allowedSecondarySchemes);

            while (resources.size >= MCP_APP_MAX_ACTIVE_RESOURCES) {
                const oldestResourceId = resources.keys().next().value as string | undefined;
                if (!oldestResourceId) break;
                removeResource(oldestResourceId);
            }
            const resourceId = randomBytes(32).toString('base64url');
            const buffered: BufferedResource = {
                resourceId,
                callId: request.callId,
                bytes: primary.bytes,
                sha256: createHash('sha256').update(primary.bytes).digest('hex'),
                expiresAt: now() + MCP_APP_RESOURCE_TTL_MS,
                ...(primary.ui ? { ui: primary.ui } : {}),
            };
            ensureOperationIsCurrent(operation);
            resources.set(resourceId, buffered);
            scheduleExpiry(buffered);

            return {
                ok: true,
                value: {
                    resourceId,
                    uri: binding.resourceUri,
                    mimeType: 'text/html;profile=mcp-app',
                    byteLength: primary.bytes.byteLength,
                    sha256: buffered.sha256,
                    encoding: 'utf8',
                    ...(buffered.ui ? { ui: buffered.ui } : {}),
                },
            };
        } catch (error) {
            return operationFailure(operation, error);
        } finally {
            endOperation(operation);
        }
        } catch {
            return failure('MCP_APP_INTERNAL', true);
        }
    };

    const resourceChunk = async (request: unknown): Promise<McpAppRpcResponse<McpAppResourceChunkResponse>> => {
        try {
            if (disposed) return failure('MCP_APP_SESSION_OFFLINE', true);
            if (!validChunkRequest(request)) return failure('MCP_APP_RESOURCE_NOT_FOUND', false);
        const resource = resources.get(request.resourceId);
        if (!resource || resource.expiresAt <= now() || !options.bindingRegistry.has(resource.callId)) {
            if (resource) removeResource(resource.resourceId);
            return failure('MCP_APP_RESOURCE_NOT_FOUND', false);
        }
        if (request.offset >= resource.bytes.byteLength) {
            return failure('MCP_APP_INVALID_RESOURCE', false);
        }

        resource.expiresAt = now() + MCP_APP_RESOURCE_TTL_MS;
        scheduleExpiry(resource);
        const bytes = resource.bytes.subarray(request.offset, request.offset + MCP_APP_CHUNK_BYTES);
        const nextOffset = request.offset + bytes.byteLength;
        return {
            ok: true,
            value: {
                offset: request.offset,
                dataBase64: Buffer.from(bytes).toString('base64'),
                ...(nextOffset < resource.bytes.byteLength ? { nextOffset } : {}),
            },
        };
        } catch {
            return failure('MCP_APP_INTERNAL', true);
        }
    };

    const resourceRead = async (request: unknown): Promise<McpAppRpcResponse<McpResourceReadResponse>> => {
        try {
            if (disposed) return failure('MCP_APP_SESSION_OFFLINE', true);
            if (!validResourceReadRequest(request) || !options.bindingRegistry.has(request.callId)) {
                return failure('MCP_APP_BINDING_NOT_FOUND', false);
            }
            const binding = options.bindingRegistry.get(request.callId);
            if (binding.connectorId && !binding.trustedOriginCallId) {
                return failure('MCP_APP_ORIGIN_MISMATCH', true);
            }
            const scheme = uriScheme(request.uri);
            const allowedSchemes = allowedSecondarySchemes.get(binding.callId) ?? new Set(['ui']);
            if (!scheme || !allowedSchemes.has(scheme)) {
                return failure('MCP_APP_INVALID_RESOURCE', false);
            }

            if (consumePreCancelledOperation(interactiveKey(request.callId, request.operationId))) {
                return failure('MCP_APP_SESSION_OFFLINE', true);
            }

            const operation = beginOperation({
                callId: request.callId,
                operationId: request.operationId,
            });
            if (!operation) return failure('MCP_APP_TIMEOUT', true);
            try {
                const response = await awaitOperation(operation, options.client.readMcpResource({
                    threadId: binding.threadId,
                    server: binding.server,
                    uri: request.uri,
                    ...(binding.trustedOriginCallId ? { originCallId: binding.trustedOriginCallId } : {}),
                    ...(binding.connectorId ? { connectorId: binding.connectorId } : {}),
                }, {
                    signal: operation.controller.signal,
                    timeoutMs: remainingOperationMs(operation),
                }));
                const safeResult = safeSecondaryResourceResult(response, request.uri);
                if (!safeResult.ok) {
                    return failure(safeResult.tooLarge ? 'MCP_APP_RESOURCE_TOO_LARGE' : 'MCP_APP_INVALID_RESOURCE', false);
                }
                return { ok: true, value: safeResult.value };
            } catch (error) {
                return operationFailure(operation, error);
            } finally {
                endOperation(operation);
            }
        } catch {
            return failure('MCP_APP_INTERNAL', true);
        }
    };

    const toolCall = async (request: unknown): Promise<McpAppRpcResponse<McpServerToolCallResponse>> => {
        try {
            if (disposed) return failure('MCP_APP_SESSION_OFFLINE', true);
            if (!validToolCallRequest(request)) return failure('MCP_APP_TOOL_NOT_ALLOWED', false);
            if (!options.bindingRegistry.has(request.callId)) return failure('MCP_APP_BINDING_NOT_FOUND', false);
            const binding = options.bindingRegistry.get(request.callId);
            const telemetryStartedAt = Date.now();
            const requestByteLength = serializedBytes(request) ?? 0;
            let originScoped = false;
            const emitToolTelemetry = (
                eventName: 'mcp_app_tool_call_requested' | 'mcp_app_tool_call_resolved',
                code: McpAppTelemetryOutcomeCode,
                byteLength = 0,
            ): void => emitMcpAppTelemetry(eventName, {
                platform: 'cli',
                stage: 'tool_call',
                durationMs: eventName === 'mcp_app_tool_call_requested'
                    ? 0
                    : Math.max(0, Date.now() - telemetryStartedAt),
                byteLength,
                originScoped,
                code,
            }, options.telemetry);
            const failToolCall = (
                code: McpAppErrorCode,
                retryable: boolean,
            ): McpAppRpcResponse<McpServerToolCallResponse> => {
                emitToolTelemetry('mcp_app_tool_call_resolved', code);
                return failure(code, retryable);
            };
            emitToolTelemetry('mcp_app_tool_call_requested', 'started', requestByteLength);
            if (binding.connectorId && !binding.trustedOriginCallId) {
                return failToolCall('MCP_APP_ORIGIN_MISMATCH', true);
            }
            if (!requestConnectorMatches(request._meta, binding.connectorId)) {
                return failToolCall('MCP_APP_TOOL_NOT_ALLOWED', false);
            }

            if (consumePreCancelledOperation(interactiveKey(request.callId, request.operationId))) {
                emitToolTelemetry('mcp_app_tool_call_resolved', 'cancelled');
                return failure('MCP_APP_SESSION_OFFLINE', true);
            }

            const operation = beginOperation({
                callId: request.callId,
                operationId: request.operationId,
            });
            if (!operation) return failToolCall('MCP_APP_TIMEOUT', true);
            try {
                const status = await awaitOperation(operation, options.client.listMcpServerStatus({
                    threadId: binding.threadId,
                    detail: 'toolsAndAuthOnly',
                    limit: 100,
                }, {
                    signal: operation.controller.signal,
                    timeoutMs: remainingOperationMs(operation),
                }));

                const match = adapter.findCatalogTool(status, binding.server, request.tool);
                if (!match || !match.serverEnabled || !match.toolEnabled || !match.appVisible
                    || (match.connectorId !== undefined && match.connectorId !== binding.connectorId)) {
                    return failToolCall('MCP_APP_TOOL_NOT_ALLOWED', false);
                }

                const annotations = match.annotations;
                const risky = annotations.readOnlyHint !== true
                    || annotations.destructiveHint === true
                    || annotations.openWorldHint === true;
                ensureOperationIsCurrent(operation);
                requestSequence += 1;
                if (risky) {
                    ensureOperationIsCurrent(operation);
                    const decision = await awaitOperation(
                        operation,
                        options.permissionHandler.handleToolCall(
                            `mcp-app-${binding.callId}-${requestSequence}`,
                            `mcp__${binding.server}__${request.tool}`,
                            request.arguments ?? {},
                            { signal: operation.controller.signal },
                        ),
                    );
                    if (decision.decision === 'denied' || decision.decision === 'abort') {
                        return failToolCall('MCP_APP_PERMISSION_DENIED', false);
                    }
                }

                ensureOperationIsCurrent(operation);
                const timeoutMs = remainingOperationMs(operation);
                const originCallId = binding.callId;
                originScoped = true;
                const response = await awaitOperation(operation, options.client.callMcpTool({
                    threadId: binding.threadId,
                    server: binding.server,
                    tool: request.tool,
                    ...(request.arguments !== undefined ? { arguments: request.arguments } : {}),
                    originCallId,
                }, {
                    signal: operation.controller.signal,
                    timeoutMs,
                }));
                const safeResult = safeToolResult(response);
                if (!safeResult.ok) {
                    return failToolCall(
                        safeResult.tooLarge ? 'MCP_APP_RESULT_TOO_LARGE' : 'MCP_APP_INTERNAL',
                        false,
                    );
                }
                emitToolTelemetry(
                    'mcp_app_tool_call_resolved',
                    'succeeded',
                    serializedBytes(safeResult.value) ?? 0,
                );
                return { ok: true, value: safeResult.value };
            } catch (error) {
                const response = operationFailure<McpServerToolCallResponse>(operation, error);
                emitToolTelemetry(
                    'mcp_app_tool_call_resolved',
                    operation.cancelled
                        ? 'cancelled'
                        : response.ok ? 'MCP_APP_INTERNAL' : response.error.code,
                );
                return response;
            } finally {
                endOperation(operation);
            }
        } catch {
            return failure('MCP_APP_INTERNAL', true);
        }
    };

    const operationCancel = async (
        request: unknown,
    ): Promise<McpAppRpcResponse<Record<string, never>>> => {
        try {
            if (disposed) return failure('MCP_APP_SESSION_OFFLINE', true);
            if (!validCancelRequest(request)) return failure('MCP_APP_BRIDGE_PROTOCOL', false);
            const key = interactiveKey(request.callId, request.operationId);
            const operation = interactiveOperations.get(key);
            if (operation) {
                interactiveOperations.delete(key);
                operation.cancelled = true;
                operation.controller.abort();
            } else if (options.bindingRegistry.has(request.callId)) {
                rememberPreCancelledOperation(key);
            }
            return { ok: true, value: {} };
        } catch {
            return failure('MCP_APP_INTERNAL', false);
        }
    };

    const register = (manager: McpAppRpcHandlerManager): void => {
        manager.registerHandler('mcpAppResourceOpen', resourceOpen);
        manager.registerHandler('mcpAppResourceChunk', resourceChunk);
        manager.registerHandler('mcpAppResourceRead', resourceRead);
        manager.registerHandler('mcpAppToolCall', toolCall);
        manager.registerHandler('mcpAppOperationCancel', operationCancel);
    };
    const unregister = (manager: McpAppRpcHandlerManager): void => {
        manager.unregisterHandler('mcpAppResourceOpen');
        manager.unregisterHandler('mcpAppResourceChunk');
        manager.unregisterHandler('mcpAppResourceRead');
        manager.unregisterHandler('mcpAppToolCall');
        manager.unregisterHandler('mcpAppOperationCancel');
    };
    register(rpcHandlerManager);

    return {
        resourceOpen,
        resourceChunk,
        resourceRead,
        toolCall,
        operationCancel,
        rebind(nextRpcHandlerManager: McpAppRpcHandlerManager): void {
            if (disposed || nextRpcHandlerManager === rpcHandlerManager) return;
            unregister(rpcHandlerManager);
            abortInFlightOperations();
            clearBufferedResources();
            rpcHandlerManager = nextRpcHandlerManager;
            register(rpcHandlerManager);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            abortInFlightOperations();
            clearBufferedResources();
            unregister(rpcHandlerManager);
        },
    };
}
