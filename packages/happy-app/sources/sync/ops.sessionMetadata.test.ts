import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRestoreMetadata, sessionUpdateMetadata } from './ops';

const mocks = vi.hoisted(() => ({
    encryptRaw: vi.fn(async (metadata: unknown) => `encrypted:${JSON.stringify(metadata)}`),
    decryptRaw: vi.fn(async (metadata: string) => JSON.parse(metadata.replace(/^encrypted:/, ''))),
    emitWithAck: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        emitWithAck: mocks.emitWithAck,
    },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => ({
                encryptRaw: mocks.encryptRaw,
                decryptRaw: mocks.decryptRaw,
            }),
        },
    },
}));

describe('sessionUpdateMetadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates encrypted session metadata with optimistic concurrency', async () => {
        mocks.emitWithAck.mockResolvedValueOnce({
            result: 'success',
            version: 3,
            metadata: 'encrypted:{"path":"/repo","host":"mac","summary":{"text":"New title","updatedAt":123}}',
        });

        const result = await sessionUpdateMetadata(
            'session-1',
            { path: '/repo', host: 'mac', summary: { text: 'Old title', updatedAt: 1 } },
            2,
            metadata => ({ ...metadata, summary: { text: 'New title', updatedAt: 123 } }),
        );

        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: 'session-1',
            expectedVersion: 2,
            metadata: 'encrypted:{"path":"/repo","host":"mac","summary":{"text":"New title","updatedAt":123}}',
        });
        expect(result).toEqual({
            version: 3,
            metadata: { path: '/repo', host: 'mac', summary: { text: 'New title', updatedAt: 123 } },
        });
    });

    it('persists an application restore for the observed turn through metadata conflict recovery', async () => {
        const metadata = { path: '/app', host: 'mac', application: { appId: 'advisor', bindingId: 'b' } };
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'version-mismatch', version: 2,
            metadata: `encrypted:${JSON.stringify({ ...metadata, summary: { text: 'new title', updatedAt: 11 } })}` });
        mocks.emitWithAck.mockImplementationOnce(async (_event, request) => ({ result: 'success', version: 3, metadata: request.metadata }));
        const result = await sessionRestoreMetadata({ id: 'app', metadata, metadataVersion: 1,
            agentState: { turnStatus: { status: 'completed', turnId: 'observed', updatedAt: 10 } } });
        expect(result.metadata.applicationArchiveRestoredThrough).toEqual({ turnId: 'observed', updatedAt: 10 });
        expect(result.metadata.summary?.text).toBe('new title');
        expect(mocks.emitWithAck.mock.calls.map(([method]) => method)).toEqual(['update-metadata', 'update-metadata']);
    });

    it('retries after a metadata version mismatch using the latest server metadata', async () => {
        mocks.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 7,
                metadata: 'encrypted:{"path":"/repo","host":"mac","name":"latest"}',
            })
            .mockResolvedValueOnce({
                result: 'success',
                version: 8,
                metadata: 'encrypted:{"path":"/repo","host":"mac","name":"latest","summary":{"text":"Manual","updatedAt":456}}',
            });

        const result = await sessionUpdateMetadata(
            'session-1',
            { path: '/repo', host: 'mac' },
            2,
            metadata => ({ ...metadata, summary: { text: 'Manual', updatedAt: 456 } }),
        );

        expect(mocks.emitWithAck).toHaveBeenCalledTimes(2);
        expect(mocks.emitWithAck).toHaveBeenLastCalledWith('update-metadata', {
            sid: 'session-1',
            expectedVersion: 7,
            metadata: 'encrypted:{"path":"/repo","host":"mac","name":"latest","summary":{"text":"Manual","updatedAt":456}}',
        });
        expect(result.version).toBe(8);
        expect(result.metadata.summary?.text).toBe('Manual');
    });
});
