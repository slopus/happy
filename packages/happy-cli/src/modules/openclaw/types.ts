/**
 * OpenClaw Tunnel Types
 *
 * Types for the OpenClaw tunnel that relays WebSocket messages between
 * the mobile app and an OpenClaw gateway running on the local machine.
 */

// Tunnel connection status
export type OpenClawTunnelStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'pairing_required'
    | 'error';

// Configuration for connecting to an OpenClaw gateway
export interface OpenClawTunnelConfig {
    url: string;              // WebSocket URL (e.g., "ws://localhost:18789")
    token?: string;           // Auth token (for authenticated access)
    password?: string;        // Auth password (alternative)
}

// OpenClaw protocol frame types
export interface OpenClawRequestFrame {
    type: 'req';
    id: string;
    method: string;
    params?: unknown;
}

export interface OpenClawResponseFrame {
    type: 'res';
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string };
}

export interface OpenClawEventFrame {
    type: 'event';
    event: string;
    payload?: unknown;
    payloadJSON?: string;
    seq?: number;
}

export type OpenClawFrame = OpenClawRequestFrame | OpenClawResponseFrame | OpenClawEventFrame;

// RPC request/response types for tunnel operations

// openclaw-connect: Establish connection to an OpenClaw gateway
export interface OpenClawConnectRequest {
    tunnelId: string;         // Client-generated tunnel ID
    config: OpenClawTunnelConfig;
    // Device identity for authentication
    device?: {
        id: string;
        publicKey: string;    // Base64URL encoded Ed25519 public key
        privateKey: string;   // Base64URL encoded Ed25519 private key (used for signing)
    };
}

export interface OpenClawConnectResponse {
    ok: boolean;
    status: OpenClawTunnelStatus;
    error?: string;
    // Returned on successful connection
    mainSessionKey?: string;
    serverHost?: string;
    // Returned when pairing is required
    pairingRequestId?: string;
    // Device token issued after successful pairing
    deviceToken?: string;
}

// openclaw-send: Send a request through the tunnel
export interface OpenClawSendRequest {
    tunnelId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
}

export interface OpenClawSendResponse {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

// openclaw-close: Close a tunnel connection
export interface OpenClawCloseRequest {
    tunnelId: string;
}

export interface OpenClawCloseResponse {
    ok: boolean;
}

// openclaw-status: Get status of a tunnel
export interface OpenClawStatusRequest {
    tunnelId: string;
}

export interface OpenClawStatusResponse {
    ok: boolean;
    status: OpenClawTunnelStatus;
    mainSessionKey?: string;
    serverHost?: string;
    error?: string;
}

// Event callback for tunnel events (streaming responses, connection changes)
export type OpenClawTunnelEventCallback = (tunnelId: string, event: string, payload: unknown) => void;
