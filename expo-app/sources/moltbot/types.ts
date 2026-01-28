/**
 * Moltbot Types
 *
 * Types for Moltbot machine management and protocol communication.
 */

import { z } from 'zod';

// === Storage Types ===

/**
 * Moltbot machine metadata (encrypted)
 */
export const MoltbotMetadataSchema = z.object({
    name: z.string(),
    // Additional metadata fields can be added here
});

export type MoltbotMetadata = z.infer<typeof MoltbotMetadataSchema>;

/**
 * Moltbot pairing data (encrypted)
 */
export const MoltbotPairingDataSchema = z.object({
    deviceId: z.string(),
    publicKey: z.string(),   // Base64URL encoded Ed25519 public key
    privateKey: z.string(),  // Base64URL encoded Ed25519 private key
    deviceToken: z.string().optional(),  // Token issued after successful pairing
});

export type MoltbotPairingData = z.infer<typeof MoltbotPairingDataSchema>;

/**
 * Moltbot direct connection config (encrypted)
 */
export const MoltbotDirectConfigSchema = z.object({
    url: z.string(),
    password: z.string().optional(),
});

export type MoltbotDirectConfig = z.infer<typeof MoltbotDirectConfigSchema>;

/**
 * Moltbot machine stored in the app
 */
export interface MoltbotMachine {
    id: string;
    type: 'happy' | 'direct';

    // type='happy' - Reference to Happy machine for relay
    happyMachineId: string | null;

    // type='direct' - Direct connection config (decrypted)
    directConfig: MoltbotDirectConfig | null;

    // General metadata (decrypted)
    metadata: MoltbotMetadata | null;
    metadataVersion: number;

    // Pairing data (decrypted)
    pairingData: MoltbotPairingData | null;

    seq: number;
    createdAt: number;
    updatedAt: number;
}

// === Protocol Types ===

/**
 * Moltbot connection status
 */
export type MoltbotConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'pairing_required'
    | 'error';

/**
 * Moltbot protocol frame types
 */
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

/**
 * Moltbot session
 */
export interface MoltbotSession {
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

/**
 * Moltbot chat message
 */
export interface MoltbotChatMessage {
    role: 'user' | 'assistant';
    content: Array<{ type: string; text?: string }> | string;
    timestamp?: number;
    stopReason?: string;
}

/**
 * Moltbot chat event (streamed from gateway)
 */
export interface MoltbotChatEvent {
    runId: string;
    sessionKey: string;
    seq: number;
    state: 'started' | 'thinking' | 'delta' | 'tool' | 'final' | 'error';
    message?: MoltbotChatMessage;
    delta?: string;
    errorMessage?: string;
}
