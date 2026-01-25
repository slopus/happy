import { describe, expect, it } from 'vitest';

import { updateSessionMetadataWithRetry } from './updateSessionMetadataWithRetry';

type Metadata = {
    path: string;
    host: string;
    readStateV1?: { v: 1; sessionSeq: number; pendingActivityAt: number; updatedAt: number };
    messageQueueV1?: { v: 1; queue: any[]; inFlight?: any | null };
};

describe('updateSessionMetadataWithRetry', () => {
    it('retries multiple version-mismatches and applies the latest server metadata before succeeding', async () => {
        const sessionId = 's1';

        const sessions: Record<string, { metadataVersion: number; metadata: Metadata }> = {
            [sessionId]: { metadataVersion: 1, metadata: { path: '/tmp', host: 'h' } },
        };

        const decryptMetadata = async (_version: number, encrypted: string): Promise<Metadata | null> => JSON.parse(encrypted);
        const encryptMetadata = async (metadata: Metadata): Promise<string> => JSON.stringify(metadata);

        const applySessionMetadata = (next: { metadataVersion: number; metadata: Metadata }) => {
            sessions[sessionId] = next;
        };

        const calls: Array<{ expectedVersion: number; metadata: Metadata }> = [];

        const emitUpdateMetadata = async (payload: { sid: string; expectedVersion: number; metadata: string }) => {
            const parsed = JSON.parse(payload.metadata) as Metadata;
            calls.push({ expectedVersion: payload.expectedVersion, metadata: parsed });

            if (payload.expectedVersion === 1) {
                return {
                    result: 'version-mismatch' as const,
                    version: 2,
                    metadata: JSON.stringify({ path: '/tmp', host: 'h', messageQueueV1: { v: 1, queue: [{ localId: 'a' }], inFlight: null } }),
                };
            }

            if (payload.expectedVersion === 2) {
                return {
                    result: 'version-mismatch' as const,
                    version: 3,
                    metadata: JSON.stringify({ path: '/tmp', host: 'h', messageQueueV1: { v: 1, queue: [{ localId: 'a' }, { localId: 'b' }], inFlight: null } }),
                };
            }

            return {
                result: 'success' as const,
                version: payload.expectedVersion + 1,
                metadata: payload.metadata,
            };
        };

        const refreshSessions = async () => {
            // Should not be required when the server provides version+metadata on mismatch.
            throw new Error('refreshSessions should not be called');
        };

        await updateSessionMetadataWithRetry({
            sessionId,
            getSession: () => sessions[sessionId] ?? null,
            refreshSessions,
            encryptMetadata,
            decryptMetadata,
            emitUpdateMetadata,
            applySessionMetadata,
            updater: (base) => ({
                ...base,
                readStateV1: { v: 1 as const, sessionSeq: 5, pendingActivityAt: 10, updatedAt: 123 },
            }),
            maxAttempts: 5,
        });

        expect(calls.map((c) => c.expectedVersion)).toEqual([1, 2, 3]);
        expect(sessions[sessionId]?.metadataVersion).toBe(4);
        expect(sessions[sessionId]?.metadata.readStateV1?.sessionSeq).toBe(5);
        expect(sessions[sessionId]?.metadata.messageQueueV1?.queue.length).toBe(2);
    });
});
