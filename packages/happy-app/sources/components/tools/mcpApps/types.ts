import type { McpAppResourceUi } from './resourceUiMetadata';

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

export class McpAppHostError extends Error {
    readonly code: McpAppErrorCode;
    readonly retryable: boolean;
    readonly summary: string;

    constructor(code: McpAppErrorCode, retryable: boolean, summary: string) {
        super(summary);
        this.name = 'McpAppHostError';
        this.code = code;
        this.retryable = retryable;
        this.summary = summary;
    }
}

export type McpAppToolResult = {
    content: unknown[];
    structuredContent?: unknown;
    _meta?: unknown;
    isError?: boolean;
};

export type McpAppReadResourceResult = {
    contents: unknown[];
    _meta?: unknown;
};

export type McpAppResource = {
    resourceId: string;
    uri: string;
    mimeType: 'text/html;profile=mcp-app';
    byteLength: number;
    sha256: string;
    encoding: 'utf8';
    html: string;
    ui?: McpAppResourceUi;
};

export type ReadMcpAppResourceInput = {
    callId: string;
    expectedResourceUri?: string;
    signal?: AbortSignal;
};

export type CallMcpAppToolInput = {
    callId: string;
    tool: string;
    arguments?: Record<string, unknown>;
    _meta?: unknown;
    signal?: AbortSignal;
};

export type ReadSecondaryMcpAppResourceInput = {
    callId: string;
    uri: string;
    signal?: AbortSignal;
};

export type { McpAppBridgeRequest, McpAppBridgeResponse } from '../../../../mcp-app-sandbox/protocol';

export interface McpAppRemotePort {
    readResource(input: ReadMcpAppResourceInput): Promise<McpAppResource>;
    readSecondaryResource(input: ReadSecondaryMcpAppResourceInput): Promise<McpAppReadResourceResult>;
    callTool(input: CallMcpAppToolInput): Promise<McpAppToolResult>;
}

export type McpAppHostContext = {
    theme: 'light' | 'dark';
    locale: string;
    platform: 'web' | 'android' | 'ios' | 'desktop';
    touch: boolean;
    hover: boolean;
    container: { width: number; height: number };
    safeAreaInsets: { top: number; right: number; bottom: number; left: number };
    displayMode: 'inline';
};

export type FrameMountInput = {
    resource: McpAppResource;
    context: McpAppHostContext;
    signal: AbortSignal;
    /** Called once the sandbox proxy is ready and View initialization begins. */
    onSandboxReady(): void;
    /** Called if an already-mounted frame later loses protocol or WebView integrity. */
    onFailure(error: McpAppHostError): void;
    /** Handles one validated, authority-free request from the owned View instance. */
    onRequest(
        request: import('../../../../mcp-app-sandbox/protocol').McpAppBridgeRequest,
        signal?: AbortSignal,
    ): Promise<unknown>;
};

export interface McpAppFrame {
    sendToolInput(input: Record<string, unknown>): void;
    sendToolResult(result: McpAppToolResult): void;
    sendToolCancelled(reason: string): void;
    updateHostContext(context: McpAppHostContext): void;
    teardown(): Promise<void>;
}

export interface McpAppFrameAdapter {
    /** Missing means supported for legacy/test adapters; production unsupported adapters set this explicitly. */
    readonly support?: 'supported' | 'unsupported';
    /** True only when the transport enforces a verified exact browser origin. */
    readonly originScoped?: boolean;
    /** Resolves only after the View has completed initialization. */
    mount(input: FrameMountInput): Promise<McpAppFrame>;
}
