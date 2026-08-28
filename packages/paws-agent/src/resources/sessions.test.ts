import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, encryptLegacy } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
import { SessionsResourceImpl } from './sessions';

const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
const credentials = {
    token: 'token',
    secret,
    contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
};

describe('SessionsResource', () => {
    it('loads the active snapshot and keeps encryption material private', async () => {
        const transport = {
            getWithCredentials: vi.fn().mockResolvedValue({
                data: { sessions: [{
                    id: 'session-1', seq: 1, createdAt: 2, updatedAt: 3,
                    active: true, activeAt: 4,
                    metadata: encodeBase64(encryptLegacy({ machineId: 'machine-1' }, secret)),
                    metadataVersion: 5,
                    agentState: encodeBase64(encryptLegacy({ requests: {} }, secret)),
                    agentStateVersion: 6,
                    dataEncryptionKey: null,
                }] },
                credentials,
            }),
        };
        const sessions = new SessionsResourceImpl(
            transport as never,
            {} as never,
            new RecordEncryptionStore(),
            vi.fn(),
        );

        const result = await sessions.list({ active: true });
        expect(transport.getWithCredentials).toHaveBeenCalledWith('/v2/sessions/active');
        expect(result[0]).toMatchObject({
            id: 'session-1',
            metadata: { machineId: 'machine-1' },
            agentState: { requests: {} },
        });
        expect(JSON.stringify(result)).not.toContain('dataEncryptionKey');
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it.each([
        null,
        {},
        { type: 'success' },
        { type: 'requestToApproveDirectoryCreation' },
        { type: 'error' },
        { type: 'unexpected', sessionId: 'session-1' },
    ])('rejects malformed spawn RPC results: %j', async malformed => {
        const realtime = { machineRpc: vi.fn().mockResolvedValue(malformed) };
        const sessions = new SessionsResourceImpl(
            {} as never,
            realtime as never,
            new RecordEncryptionStore(),
            vi.fn().mockResolvedValue([{ id: 'machine-1' }]),
        );

        await expect(sessions.spawn({ machineId: 'machine-1', directory: '/tmp/project' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    });

    it.each([
        { type: 'success', sessionId: 'session-1' },
        { type: 'requestToApproveDirectoryCreation', directory: '/tmp/new' },
        { type: 'error', errorMessage: 'failed' },
    ])('accepts a valid spawn RPC result: %j', async result => {
        const realtime = { machineRpc: vi.fn().mockResolvedValue(result) };
        const sessions = new SessionsResourceImpl(
            {} as never,
            realtime as never,
            new RecordEncryptionStore(),
            vi.fn().mockResolvedValue([{ id: 'machine-1' }]),
        );

        await expect(sessions.spawn({ machineId: 'machine-1', directory: '/tmp/project' }))
            .resolves.toEqual(result);
    });
});
