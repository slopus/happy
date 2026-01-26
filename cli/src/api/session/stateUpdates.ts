import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time';
import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';

type AckableSocket = {
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
};

export async function updateSessionMetadataWithAck(opts: {
    socket: AckableSocket;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    getMetadata: () => Metadata | null;
    setMetadata: (metadata: Metadata | null) => void;
    getMetadataVersion: () => number;
    setMetadataVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (metadata: Metadata) => Metadata;
}): Promise<void> {
    await backoff(async () => {
        if (opts.getMetadataVersion() < 0) {
            await opts.syncSessionSnapshotFromServer();
            if (opts.getMetadataVersion() < 0) {
                logger.debug('[API] updateMetadata skipped: metadataVersion is still unknown');
                return;
            }
        }

        const current = opts.getMetadata();
        const updated = opts.handler(current!);
        const answer = await opts.socket.emitWithAck('update-metadata', {
            sid: opts.sessionId,
            expectedVersion: opts.getMetadataVersion(),
            metadata: encodeBase64(encrypt(opts.encryptionKey, opts.encryptionVariant, updated)),
        });

        if (answer.result === 'success') {
            opts.setMetadata(decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.metadata)));
            opts.setMetadataVersion(answer.version);
            return;
        }

        if (answer.result === 'version-mismatch') {
            if (answer.version > opts.getMetadataVersion()) {
                opts.setMetadataVersion(answer.version);
                opts.setMetadata(decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.metadata)));
            }
            throw new Error('Metadata version mismatch');
        }

        // Hard error - ignore
    });
}

export async function updateSessionAgentStateWithAck(opts: {
    socket: AckableSocket;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    getAgentState: () => AgentState | null;
    setAgentState: (agentState: AgentState | null) => void;
    getAgentStateVersion: () => number;
    setAgentStateVersion: (version: number) => void;
    syncSessionSnapshotFromServer: () => Promise<void>;
    handler: (agentState: AgentState) => AgentState;
}): Promise<void> {
    await backoff(async () => {
        if (opts.getAgentStateVersion() < 0) {
            await opts.syncSessionSnapshotFromServer();
            if (opts.getAgentStateVersion() < 0) {
                logger.debug('[API] updateAgentState skipped: agentStateVersion is still unknown');
                return;
            }
        }

        const updated = opts.handler(opts.getAgentState() || {});
        const answer = await opts.socket.emitWithAck('update-state', {
            sid: opts.sessionId,
            expectedVersion: opts.getAgentStateVersion(),
            agentState: updated ? encodeBase64(encrypt(opts.encryptionKey, opts.encryptionVariant, updated)) : null,
        });

        if (answer.result === 'success') {
            opts.setAgentState(answer.agentState ? decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.agentState)) : null);
            opts.setAgentStateVersion(answer.version);
            logger.debug('Agent state updated', opts.getAgentState());
            return;
        }

        if (answer.result === 'version-mismatch') {
            if (answer.version > opts.getAgentStateVersion()) {
                opts.setAgentStateVersion(answer.version);
                opts.setAgentState(answer.agentState ? decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(answer.agentState)) : null);
            }
            throw new Error('Agent state version mismatch');
        }

        // Hard error - ignore
    });
}

