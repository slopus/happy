import { decodeBase64 } from '@/encryption/base64';
import {
    mcpAppResourceRpcClient,
    type McpAppResourceOpenResponse,
    type McpAppResourceRpcClient,
} from '@/sync/ops.mcpApps';
import {
    McpAppHostError,
    type CallMcpAppToolInput,
    type McpAppReadResourceResult,
    type McpAppRemotePort,
    type McpAppResource,
    type McpAppToolResult,
    type ReadMcpAppResourceInput,
    type ReadSecondaryMcpAppResourceInput,
} from './types';
import { normalizeMcpAppResourceUi } from './resourceUiMetadata';

const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidResource(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_INVALID_RESOURCE',
        false,
        'The App resource is invalid.',
    );
}

function resourceTooLarge(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_RESOURCE_TOO_LARGE',
        false,
        'The App resource is too large.',
    );
}

function verificationUnavailable(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_INTERNAL',
        true,
        'The App resource could not be verified.',
    );
}

function invalidInteractiveResponse(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_INTERNAL',
        false,
        'The App request could not be completed.',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeResourceResult(value: unknown): McpAppReadResourceResult {
    if (!isRecord(value) || !Array.isArray(value.contents)) throw invalidInteractiveResponse();
    return {
        contents: value.contents,
        ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
    };
}

function normalizeToolResult(value: unknown): McpAppToolResult {
    if (!isRecord(value) || !Array.isArray(value.content)
        || (value.isError !== undefined && typeof value.isError !== 'boolean')) {
        throw invalidInteractiveResponse();
    }
    return {
        content: value.content,
        ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
        ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
        ...(value.isError !== undefined ? { isError: value.isError } : {}),
    };
}

function validOpenResponse(
    response: McpAppResourceOpenResponse,
    expectedResourceUri?: string,
): boolean {
    return typeof response.resourceId === 'string' && response.resourceId.length > 0
        && typeof response.uri === 'string' && response.uri.startsWith('ui://')
        && (!expectedResourceUri || response.uri === expectedResourceUri)
        && response.mimeType === 'text/html;profile=mcp-app'
        && Number.isInteger(response.byteLength) && response.byteLength > 0
        && SHA256_HEX.test(response.sha256)
        && response.encoding === 'utf8';
}

function decodeChunk(dataBase64: unknown): Uint8Array {
    if (typeof dataBase64 !== 'string' || !BASE64.test(dataBase64)) {
        throw invalidResource();
    }
    try {
        return decodeBase64(dataBase64);
    } catch {
        throw invalidResource();
    }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const Crypto = await import('expo-crypto');
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestInput));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMcpAppRemotePort(options: {
    sessionId: string;
    rpc?: McpAppResourceRpcClient;
    hashBytes?: (bytes: Uint8Array) => Promise<string>;
}): McpAppRemotePort {
    const rpc = options.rpc ?? mcpAppResourceRpcClient;
    const hashBytes = options.hashBytes ?? sha256Hex;

    return {
        async readResource(input: ReadMcpAppResourceInput): Promise<McpAppResource> {
            const open = await rpc.openResource(options.sessionId, { callId: input.callId }, input.signal);
            if (!validOpenResponse(open, input.expectedResourceUri)) throw invalidResource();
            const ui = normalizeMcpAppResourceUi(open.ui, true);
            if (ui === null) throw invalidResource();
            if (open.byteLength > MCP_APP_MAX_HTML_BYTES) throw resourceTooLarge();

            const bytes = new Uint8Array(open.byteLength);
            let requestedOffset = 0;
            while (requestedOffset < open.byteLength) {
                const chunk = await rpc.readResourceChunk(options.sessionId, {
                    resourceId: open.resourceId,
                    offset: requestedOffset,
                }, input.signal);
                if (!chunk || chunk.offset !== requestedOffset) throw invalidResource();
                const decoded = decodeChunk(chunk.dataBase64);
                if (decoded.byteLength === 0 || requestedOffset + decoded.byteLength > bytes.byteLength) {
                    throw invalidResource();
                }
                bytes.set(decoded, requestedOffset);
                const decodedEnd = requestedOffset + decoded.byteLength;
                if (chunk.nextOffset !== undefined) {
                    if (!Number.isInteger(chunk.nextOffset) || chunk.nextOffset !== decodedEnd
                        || chunk.nextOffset >= open.byteLength) {
                        throw invalidResource();
                    }
                    requestedOffset = chunk.nextOffset;
                } else {
                    if (decodedEnd !== open.byteLength) throw invalidResource();
                    requestedOffset = decodedEnd;
                }
            }

            let digest: string;
            try {
                digest = await hashBytes(bytes);
            } catch {
                throw verificationUnavailable();
            }
            if (requestedOffset !== open.byteLength || digest !== open.sha256) {
                throw invalidResource();
            }

            let html: string;
            try {
                html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                throw invalidResource();
            }
            return {
                resourceId: open.resourceId,
                uri: open.uri,
                mimeType: open.mimeType,
                byteLength: open.byteLength,
                sha256: open.sha256,
                encoding: open.encoding,
                ...(ui ? { ui } : {}),
                html,
            };
        },

        async readSecondaryResource(input: ReadSecondaryMcpAppResourceInput): Promise<McpAppReadResourceResult> {
            const result = await rpc.readSecondaryResource(options.sessionId, {
                callId: input.callId,
                uri: input.uri,
            }, input.signal);
            return normalizeResourceResult(result);
        },

        async callTool(input: CallMcpAppToolInput): Promise<McpAppToolResult> {
            const result = await rpc.callTool(options.sessionId, {
                callId: input.callId,
                tool: input.tool,
                ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
                ...(input._meta !== undefined ? { _meta: input._meta } : {}),
            }, input.signal);
            return normalizeToolResult(result);
        },
    };
}
