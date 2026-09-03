import { z } from 'zod';

export const MCP_APP_MAX_BRIDGE_MESSAGE_BYTES = 256 * 1024;
export const MCP_APP_MAX_MOUNT_HTML_BYTES = 5 * 1024 * 1024;
export const MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES = 160 * 1024;
const MCP_APP_MAX_MOUNT_CHUNK_BASE64_CHARS = Math.ceil(MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES / 3) * 4;
export const MCP_APP_MIN_FRAME_HEIGHT = 120;
export const MCP_APP_MAX_FRAME_HEIGHT = 720;

export const hostContextSchema = z.object({
    theme: z.enum(['light', 'dark']),
    locale: z.string().min(1).max(64),
    platform: z.enum(['web', 'android', 'ios', 'desktop']),
    touch: z.boolean(),
    hover: z.boolean(),
    container: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict(),
    safeAreaInsets: z.object({
        top: z.number().finite().nonnegative(), right: z.number().finite().nonnegative(),
        bottom: z.number().finite().nonnegative(), left: z.number().finite().nonnegative(),
    }).strict(),
    displayMode: z.literal('inline'),
}).strict();

const mcpAppToolResultSchema = z.object({
    content: z.array(z.unknown()),
    structuredContent: z.unknown().optional(),
    _meta: z.unknown().optional(),
    isError: z.boolean().optional(),
}).strict();

const mcpAppErrorCodeSchema = z.enum([
    'MCP_APP_UNSUPPORTED',
    'MCP_APP_SESSION_OFFLINE',
    'MCP_APP_BINDING_NOT_FOUND',
    'MCP_APP_ORIGIN_MISMATCH',
    'MCP_APP_RESOURCE_NOT_FOUND',
    'MCP_APP_INVALID_RESOURCE',
    'MCP_APP_RESOURCE_TOO_LARGE',
    'MCP_APP_RESULT_TOO_LARGE',
    'MCP_APP_TOOL_NOT_ALLOWED',
    'MCP_APP_PERMISSION_DENIED',
    'MCP_APP_SANDBOX_UNAVAILABLE',
    'MCP_APP_BRIDGE_PROTOCOL',
    'MCP_APP_TIMEOUT',
    'MCP_APP_INTERNAL',
]);

export const mcpAppBridgeRequestSchema = z.discriminatedUnion('method', [
    z.object({ method: z.literal('ping'), params: z.object({}).strict() }).strict(),
    z.object({
        method: z.literal('resources/read'),
        params: z.object({ uri: z.string().min(1).max(8_192) }).strict(),
    }).strict(),
    z.object({
        method: z.literal('tools/call'),
        params: z.object({
            name: z.string().min(1).max(256),
            arguments: z.record(z.string(), z.unknown()).optional(),
            _meta: z.unknown().optional(),
        }).strict(),
    }).strict(),
    z.object({
        method: z.literal('ui/open-link'),
        params: z.object({ url: z.string().min(1).max(8_192) }).strict(),
    }).strict(),
]);

export const mcpAppBridgeResponseSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
    z.object({
        ok: z.literal(false),
        error: z.object({
            code: mcpAppErrorCodeSchema,
            retryable: z.boolean(),
            summary: z.string().min(1).max(280),
        }).strict(),
    }).strict(),
]);

const bridgeRequestIdSchema = z.string().min(1).max(128);

export const hostCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('mount'), instanceId: z.string().min(1), html: z.string(), context: hostContextSchema }).strict(),
    z.object({
        type: z.literal('mount-start'),
        instanceId: z.string().min(1),
        byteLength: z.number().int().positive().max(MCP_APP_MAX_MOUNT_HTML_BYTES),
        context: hostContextSchema,
    }).strict(),
    z.object({
        type: z.literal('mount-chunk'),
        instanceId: z.string().min(1),
        offset: z.number().int().nonnegative().max(MCP_APP_MAX_MOUNT_HTML_BYTES - 1),
        dataBase64: z.string().min(1).max(MCP_APP_MAX_MOUNT_CHUNK_BASE64_CHARS),
    }).strict(),
    z.object({ type: z.literal('mount-complete'), instanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal('tool-input'), instanceId: z.string().min(1), input: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ type: z.literal('tool-result'), instanceId: z.string().min(1), result: mcpAppToolResultSchema }).strict(),
    z.object({ type: z.literal('tool-cancelled'), instanceId: z.string().min(1), reason: z.string().max(280) }).strict(),
    z.object({ type: z.literal('host-context'), instanceId: z.string().min(1), context: hostContextSchema }).strict(),
    z.object({
        type: z.literal('bridge-response'),
        instanceId: z.string().min(1),
        requestId: bridgeRequestIdSchema,
        response: mcpAppBridgeResponseSchema,
    }).strict(),
    z.object({ type: z.literal('teardown'), instanceId: z.string().min(1) }).strict(),
]);

export const nativeMessages = z.discriminatedUnion('type', [
    z.object({ type: z.literal('sandbox-ready'), instanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal('initialized'), instanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal('resize'), instanceId: z.string().min(1), height: z.number() }).strict(),
    z.object({
        type: z.literal('bridge-request'),
        instanceId: z.string().min(1),
        requestId: bridgeRequestIdSchema,
        request: mcpAppBridgeRequestSchema,
    }).strict(),
    z.object({
        type: z.literal('bridge-cancel'),
        instanceId: z.string().min(1),
        requestId: bridgeRequestIdSchema,
    }).strict(),
    z.object({ type: z.literal('teardown-complete'), instanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal('protocol-error'), instanceId: z.string().min(1) }).strict(),
]);

export type HostCommand = z.infer<typeof hostCommandSchema>;
export type NativeMessage = z.infer<typeof nativeMessages>;
export type McpAppBridgeRequest = z.infer<typeof mcpAppBridgeRequestSchema>;
export type McpAppBridgeResponse = z.infer<typeof mcpAppBridgeResponseSchema>;

export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
        binary += String.fromCharCode.apply(
            null,
            bytes.subarray(offset, offset + 0x8000) as unknown as number[],
        );
    }
    return btoa(binary);
}

export function createMcpAppMountCommands(
    instanceId: string,
    html: string,
    context: z.infer<typeof hostContextSchema>,
): HostCommand[] {
    const legacy = { type: 'mount' as const, instanceId, html, context };
    const legacyRaw = JSON.stringify(legacy);
    if (utf8ByteLength(legacyRaw) <= MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) return [legacy];

    const bytes = new TextEncoder().encode(html);
    if (bytes.byteLength === 0 || bytes.byteLength > MCP_APP_MAX_MOUNT_HTML_BYTES) {
        throw new Error('Invalid MCP App mount document.');
    }
    const commands: HostCommand[] = [{
        type: 'mount-start', instanceId, byteLength: bytes.byteLength, context,
    }];
    for (let offset = 0; offset < bytes.byteLength; offset += MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES) {
        commands.push({
            type: 'mount-chunk',
            instanceId,
            offset,
            dataBase64: encodeBase64(bytes.subarray(
                offset,
                offset + MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES,
            )),
        });
    }
    commands.push({ type: 'mount-complete', instanceId });
    return commands;
}

export function parseHostCommand(raw: string): HostCommand {
    if (typeof raw !== 'string' || utf8ByteLength(raw) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
        throw new Error('Invalid MCP App bridge message.');
    }
    return hostCommandSchema.parse(JSON.parse(raw));
}
