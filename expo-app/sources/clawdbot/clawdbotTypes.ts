/**
 * Clawdbot Gateway Protocol Types
 *
 * These types match the Clawdbot gateway WebSocket protocol.
 * Reference: clawdbot/src/gateway/protocol/schema.ts
 */

export interface ClawdbotGatewayConfig {
    url: string;              // e.g., "ws://192.168.1.100:18789" or Tailscale URL
    token?: string;           // Auth token (for remote access)
    password?: string;        // Auth password (alternative)
}

// Frame types matching Clawdbot protocol
export interface ClawdbotRequestFrame {
    type: 'req';
    id: string;
    method: string;
    params?: unknown;
}

export interface ClawdbotResponseFrame {
    type: 'res';
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string };
}

export interface ClawdbotEventFrame {
    type: 'event';
    event: string;
    payload?: unknown;
    payloadJSON?: string;
    seq?: number;
}

export type ClawdbotFrame = ClawdbotRequestFrame | ClawdbotResponseFrame | ClawdbotEventFrame;

// Valid client IDs accepted by the gateway protocol
export type ClawdbotClientId =
    | 'webchat-ui'
    | 'clawdbot-control-ui'
    | 'webchat'
    | 'cli'
    | 'gateway-client'
    | 'clawdbot-macos'
    | 'clawdbot-ios'
    | 'clawdbot-android'
    | 'node-host'
    | 'test'
    | 'fingerprint'
    | 'clawdbot-probe';

// Valid client modes accepted by the gateway protocol
export type ClawdbotClientMode =
    | 'webchat'
    | 'cli'
    | 'ui'
    | 'backend'
    | 'node'
    | 'probe'
    | 'test';

// Device identity for secure authentication
export interface ClawdbotDeviceIdentity {
    id: string;           // Device ID (SHA256 hash of public key)
    publicKey: string;    // Base64URL encoded Ed25519 public key
    signature: string;    // Base64URL encoded signature of auth payload
    signedAt: number;     // Timestamp when payload was signed
    nonce?: string;       // Nonce for remote connections
}

// Connect params (simplified - full spec in clawdbot/src/gateway/protocol/schema.ts)
export interface ClawdbotConnectParams {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: ClawdbotClientId;
        displayName?: string;
        version: string;
        platform: string;
        mode: ClawdbotClientMode;
    };
    role: string;
    scopes: string[];
    device?: ClawdbotDeviceIdentity;
    auth?: { token?: string; password?: string };
}

export interface ClawdbotHelloOk {
    server?: { host?: string };
    snapshot?: {
        sessionDefaults?: { mainSessionKey?: string };
    };
    auth?: {
        deviceToken?: string;  // Token issued after successful pairing
        role?: string;
        scopes?: string[];
    };
}

// Session types (matches GatewaySessionRow from clawdbot)
export interface ClawdbotSession {
    key: string;
    kind: 'direct' | 'group' | 'global' | 'unknown';
    label?: string;
    displayName?: string;
    surface?: string;
    subject?: string;
    room?: string;
    space?: string;
    updatedAt: number | null;
    sessionId?: string;
    systemSent?: boolean;
    abortedLastRun?: boolean;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    model?: string;
    modelProvider?: string;
    contextTokens?: number;
}

export interface ClawdbotSessionsListResult {
    ts: number;
    path: string;
    count: number;
    defaults: { model: string | null; contextTokens: number | null };
    sessions: ClawdbotSession[];
}

// Chat message types
export interface ClawdbotChatMessage {
    role: 'user' | 'assistant';
    content: Array<{ type: string; text?: string }> | string;
    timestamp?: number;
    stopReason?: string;
}

export interface ClawdbotChatHistoryResult {
    sessionKey: string;
    sessionId?: string;
    messages: ClawdbotChatMessage[];
    thinkingLevel?: string;
}

// Chat events (streamed from gateway)
export interface ClawdbotChatEvent {
    runId: string;
    sessionKey: string;
    seq: number;
    state: 'started' | 'thinking' | 'delta' | 'tool' | 'final' | 'error';
    message?: ClawdbotChatMessage;
    delta?: string;
    errorMessage?: string;
}

export interface ClawdbotChatSendResult {
    runId: string;
    status: 'started' | 'ok' | 'error' | 'in_flight';
    summary?: string;
}
