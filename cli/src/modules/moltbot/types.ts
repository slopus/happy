/**
 * Moltbot Tunnel Types
 *
 * Types for the Moltbot tunnel that relays WebSocket messages between
 * the mobile app and a Moltbot gateway running on the local machine.
 */

// Tunnel connection status
export type MoltbotTunnelStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'pairing_required'
    | 'error';

// Configuration for connecting to a Moltbot gateway
export interface MoltbotTunnelConfig {
    url: string;              // WebSocket URL (e.g., "ws://localhost:18789")
    token?: string;           // Auth token (for authenticated access)
    password?: string;        // Auth password (alternative)
}

// Moltbot protocol frame types
export interface MoltbotRequestFrame {
    type: 'req';
    id: string;
    method: string;
    params?: unknown;
}

export interface MoltbotResponseFrame {
    type: 'res';
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string };
}

export interface MoltbotEventFrame {
    type: 'event';
    event: string;
    payload?: unknown;
    payloadJSON?: string;
    seq?: number;
}

export type MoltbotFrame = MoltbotRequestFrame | MoltbotResponseFrame | MoltbotEventFrame;

// RPC request/response types for tunnel operations

// moltbot-connect: Establish connection to a Moltbot gateway
export interface MoltbotConnectRequest {
    tunnelId: string;         // Client-generated tunnel ID
    config: MoltbotTunnelConfig;
    // Device identity for authentication
    device?: {
        id: string;
        publicKey: string;    // Base64URL encoded Ed25519 public key
        privateKey: string;   // Base64URL encoded Ed25519 private key (used for signing)
    };
}

export interface MoltbotConnectResponse {
    ok: boolean;
    status: MoltbotTunnelStatus;
    error?: string;
    // Returned on successful connection
    mainSessionKey?: string;
    serverHost?: string;
    // Returned when pairing is required
    pairingRequestId?: string;
    // Device token issued after successful pairing
    deviceToken?: string;
}

// moltbot-send: Send a request through the tunnel
export interface MoltbotSendRequest {
    tunnelId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
}

export interface MoltbotSendResponse {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

// moltbot-close: Close a tunnel connection
export interface MoltbotCloseRequest {
    tunnelId: string;
}

export interface MoltbotCloseResponse {
    ok: boolean;
}

// moltbot-status: Get status of a tunnel
export interface MoltbotStatusRequest {
    tunnelId: string;
}

export interface MoltbotStatusResponse {
    ok: boolean;
    status: MoltbotTunnelStatus;
    mainSessionKey?: string;
    serverHost?: string;
    error?: string;
}

// Event callback for tunnel events (streaming responses, connection changes)
export type MoltbotTunnelEventCallback = (tunnelId: string, event: string, payload: unknown) => void;
