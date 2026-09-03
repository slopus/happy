import { logger } from '@/ui/logger';

export const MCP_APP_TELEMETRY_EVENT_NAMES = [
    'mcp_app_render_started',
    'mcp_app_render_succeeded',
    'mcp_app_render_failed',
    'mcp_app_tool_call_requested',
    'mcp_app_tool_call_resolved',
] as const;

export type McpAppTelemetryEventName = typeof MCP_APP_TELEMETRY_EVENT_NAMES[number];
export type McpAppTelemetryPlatform = 'cli' | 'web' | 'android' | 'ios' | 'desktop';
export type McpAppTelemetryStage = 'resource' | 'sandbox' | 'initialize' | 'tool_call';
export type McpAppTelemetryOutcomeCode =
    | 'started'
    | 'succeeded'
    | 'cancelled'
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

export type McpAppTelemetryInput = {
    platform: McpAppTelemetryPlatform;
    stage: McpAppTelemetryStage;
    durationMs: number;
    byteLength: number;
    originScoped: boolean;
    code: McpAppTelemetryOutcomeCode;
};

export type McpAppTelemetryPayload = {
    platform: McpAppTelemetryPlatform | 'unknown';
    stage: McpAppTelemetryStage | 'unknown';
    durationBucket: 'under_100ms' | '100ms_to_999ms' | '1s_to_9s' | '10s_to_29s' | '30s_or_more' | 'unknown';
    byteSizeBucket: 'zero' | 'under_1kb' | '1kb_to_63kb' | '64kb_to_511kb' | '512kb_to_5mb' | 'over_5mb' | 'unknown';
    originScoped: boolean;
    outcomeCode: McpAppTelemetryOutcomeCode;
};

export type McpAppTelemetrySink = (
    eventName: McpAppTelemetryEventName,
    payload: McpAppTelemetryPayload,
) => void | PromiseLike<void>;

const PLATFORMS = new Set<string>(['cli', 'web', 'android', 'ios', 'desktop']);
const STAGES = new Set<string>(['resource', 'sandbox', 'initialize', 'tool_call']);
const EVENT_NAMES = new Set<string>(MCP_APP_TELEMETRY_EVENT_NAMES);
const OUTCOMES = new Set<string>([
    'started',
    'succeeded',
    'cancelled',
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

function durationBucket(value: unknown): McpAppTelemetryPayload['durationBucket'] {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
    if (value < 100) return 'under_100ms';
    if (value < 1_000) return '100ms_to_999ms';
    if (value < 10_000) return '1s_to_9s';
    if (value < 30_000) return '10s_to_29s';
    return '30s_or_more';
}

function byteSizeBucket(value: unknown): McpAppTelemetryPayload['byteSizeBucket'] {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
    if (value === 0) return 'zero';
    if (value < 1_024) return 'under_1kb';
    if (value < 64 * 1_024) return '1kb_to_63kb';
    if (value < 512 * 1_024) return '64kb_to_511kb';
    if (value <= 5 * 1_024 * 1_024) return '512kb_to_5mb';
    return 'over_5mb';
}

export function buildMcpAppTelemetry(input: McpAppTelemetryInput): McpAppTelemetryPayload {
    const candidate = input as unknown as Record<string, unknown>;
    return {
        platform: typeof candidate.platform === 'string' && PLATFORMS.has(candidate.platform)
            ? candidate.platform as McpAppTelemetryPlatform
            : 'unknown',
        stage: typeof candidate.stage === 'string' && STAGES.has(candidate.stage)
            ? candidate.stage as McpAppTelemetryStage
            : 'unknown',
        durationBucket: durationBucket(candidate.durationMs),
        byteSizeBucket: byteSizeBucket(candidate.byteLength),
        originScoped: candidate.originScoped === true,
        outcomeCode: typeof candidate.code === 'string' && OUTCOMES.has(candidate.code)
            ? candidate.code as McpAppTelemetryOutcomeCode
            : 'MCP_APP_INTERNAL',
    };
}

const localLogSink: McpAppTelemetrySink = (eventName, payload) => {
    logger.debug(`[McpAppTelemetry] ${eventName}`, payload);
};

export function emitMcpAppTelemetry(
    eventName: McpAppTelemetryEventName,
    input: McpAppTelemetryInput,
    sink: McpAppTelemetrySink = localLogSink,
): void {
    if (!EVENT_NAMES.has(eventName)) return;
    try {
        const pending = sink(eventName, buildMcpAppTelemetry(input));
        if (pending !== undefined) {
            void Promise.resolve(pending).catch(() => {});
        }
    } catch {
        // Diagnostics must never affect MCP App control flow.
    }
}
