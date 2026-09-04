import { describe, expect, it, vi } from 'vitest';
import { encryptLegacy, encodeBase64 } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
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
        const resource = new MachinesResourceImpl(transport as never, {} as never, new RecordEncryptionStore());

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
        const resource = new MachinesResourceImpl(transport as never, {} as never, new RecordEncryptionStore());
        await resource.list({ active: true });
        expect(transport.getWithCredentials).toHaveBeenCalledWith('/v1/machines');
    });

    it('browses a home-scoped remote directory through the machine RPC', async () => {
        const response = {
            success: true,
            path: '/Users/jacky/projects',
            parent: '/Users/jacky',
            home: '/Users/jacky',
            directories: [
                { name: 'paws', path: '/Users/jacky/projects/paws', isProjectRoot: true },
            ],
        };
        const realtime = { machineRpc: vi.fn().mockResolvedValue(response) };
        const resource = new MachinesResourceImpl({} as never, realtime as never);

        await expect(resource.browseDirectory({
            machineId: 'machine-1',
            path: '/Users/jacky/projects',
        })).resolves.toEqual(response);
        expect(realtime.machineRpc).toHaveBeenCalledWith(
            'machine-1',
            'browseDirectory',
            { path: '/Users/jacky/projects' },
        );
    });

    it('uses the remote home when the browse path is omitted', async () => {
        const realtime = {
            machineRpc: vi.fn().mockResolvedValue({
                success: true,
                path: '/Users/jacky',
                parent: null,
                home: '/Users/jacky',
                directories: [],
            }),
        };
        const resource = new MachinesResourceImpl({} as never, realtime as never);

        await resource.browseDirectory({ machineId: 'machine-1' });

        expect(realtime.machineRpc).toHaveBeenCalledWith('machine-1', 'browseDirectory', { path: '' });
    });

    it.each([
        null,
        {},
        { success: true },
        { success: true, path: '/Users/jacky', parent: null, home: '/Users/jacky', directories: [{ name: 'bad' }] },
        { success: false },
    ])('rejects malformed browseDirectory RPC results: %j', async malformed => {
        const realtime = { machineRpc: vi.fn().mockResolvedValue(malformed) };
        const resource = new MachinesResourceImpl({} as never, realtime as never);

        await expect(resource.browseDirectory({ machineId: 'machine-1' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    });

    it('rejects a blank machine id without sending an RPC', async () => {
        const realtime = { machineRpc: vi.fn() };
        const resource = new MachinesResourceImpl({} as never, realtime as never);

        await expect(resource.browseDirectory({ machineId: '  ' }))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(realtime.machineRpc).not.toHaveBeenCalled();
    });
});
