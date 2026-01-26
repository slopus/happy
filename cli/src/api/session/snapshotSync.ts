import axios from 'axios';
import { configuration } from '@/configuration';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';

export function shouldSyncSessionSnapshotOnConnect(opts: { metadataVersion: number; agentStateVersion: number }): boolean {
    return opts.metadataVersion < 0 || opts.agentStateVersion < 0;
}

export async function fetchSessionSnapshotUpdateFromServer(opts: {
    token: string;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
}): Promise<{
    metadata?: { metadata: Metadata; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
}> {
    const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
        headers: {
            Authorization: `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
        },
        timeout: 10_000,
    });

    const sessions = (response?.data as any)?.sessions;
    if (!Array.isArray(sessions)) {
        return {};
    }

    const raw = sessions.find((s: any) => s && typeof s === 'object' && s.id === opts.sessionId);
    if (!raw) {
        return {};
    }

    const out: {
        metadata?: { metadata: Metadata; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
    } = {};

    // Sync metadata if it is newer than our local view.
    const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
    const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion > opts.currentMetadataVersion) {
        const decrypted = decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawMetadata));
        if (decrypted) {
            out.metadata = {
                metadata: decrypted,
                metadataVersion: nextMetadataVersion,
            };
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (nextAgentStateVersion !== null && nextAgentStateVersion > opts.currentAgentStateVersion) {
        out.agentState = {
            agentState: rawAgentState ? decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawAgentState)) : null,
            agentStateVersion: nextAgentStateVersion,
        };
    }

    return out;
}

