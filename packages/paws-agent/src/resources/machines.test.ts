import { describe, expect, it, vi } from 'vitest';
import { encryptLegacy, encodeBase64 } from '../crypto/encryption';
import { MachinesResourceImpl } from './machines';

const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
const credentials = {
    token: 'token',
    secret,
    contentKeyPair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
    },
};

describe('MachinesResource', () => {
    it('returns decrypted SDK-owned values without encryption material', async () => {
        const transport = {
            getWithCredentials: vi.fn().mockResolvedValue({ data: [{
                id: 'machine-1',
                seq: 4,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 19,
                metadata: encodeBase64(encryptLegacy({ host: 'studio' }, secret)),
                metadataVersion: 2,
                daemonState: encodeBase64(encryptLegacy({ status: 'ready' }, secret)),
                daemonStateVersion: 3,
                dataEncryptionKey: null,
            }], credentials }),
        };
        const resource = new MachinesResourceImpl(transport as never);

        const result = await resource.list({ active: true });

        expect(transport.getWithCredentials).toHaveBeenCalledWith('/v1/machines');
        expect(result).toEqual([{
            id: 'machine-1',
            seq: 4,
            createdAt: 10,
            updatedAt: 20,
            active: true,
            activeAt: 19,
            metadata: { host: 'studio' },
            metadataVersion: 2,
            daemonState: { status: 'ready' },
            daemonStateVersion: 3,
        }]);
        expect(JSON.stringify(result)).not.toContain('encryption');
        expect(JSON.stringify(result)).not.toContain('dataEncryptionKey');
    });

    it('uses the active snapshot endpoint when requested', async () => {
        const transport = { getWithCredentials: vi.fn().mockResolvedValue({ data: [], credentials }) };
        const resource = new MachinesResourceImpl(transport as never);
        await resource.list({ active: true });
        expect(transport.getWithCredentials).toHaveBeenCalledWith('/v1/machines');
    });
});
