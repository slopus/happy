import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({
    default: {
        get,
        post,
        isAxiosError: (error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError,
    },
}));

import { configuration } from '@/configuration';
import { readCredentials, readMachineIdentity } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { MachineKeyRotationConflict, type MachineKeyRotationRequest, type PendingMachineKeyRotation } from './machineControl';
import { createMachineControlIo, pendingMachineKeyRotationFile } from './machineControlIo';

const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
});

const pending: PendingMachineKeyRotation = {
    version: 1,
    machineId: 'machine-1',
    fromKeySha256: 'a'.repeat(64),
    machineKey: encodeBase64(new Uint8Array(32).fill(9)),
    dataEncryptionKey: 'account-envelope',
    serverRpcKeyEnvelope: null,
};

describe('createMachineControlIo', () => {
    const io = createMachineControlIo({ token: 'token', machineId: 'machine-1' });

    beforeEach(() => {
        get.mockReset();
        post.mockReset();
    });

    afterEach(async () => {
        await rm(pendingMachineKeyRotationFile(), { force: true });
    });

    it('keeps the pending record owner-only and removes it', async () => {
        await expect(io.readPending()).resolves.toBeNull();

        await io.writePending(pending);
        await expect(io.readPending()).resolves.toEqual(pending);
        if (process.platform !== 'win32') {
            expect(statSync(pendingMachineKeyRotationFile()).mode & 0o777).toBe(0o600);
        }

        await io.deletePending();
        expect(existsSync(pendingMachineKeyRotationFile())).toBe(false);
    });

    it('still reports a record it cannot parse, so the planner can discard it', async () => {
        writeFileSync(pendingMachineKeyRotationFile(), '{ not json');

        await expect(io.readPending()).resolves.not.toBeNull();
    });

    it('replaces access.key and the key a re-login would reuse', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = new Uint8Array(32).fill(2);

        await io.writeCredentials({ token: 'token', encryption: { type: 'dataKey', publicKey, machineKey, neverEscrowed: true } });

        expect((await readCredentials())!.encryption).toEqual({ type: 'dataKey', publicKey, machineKey, neverEscrowed: true });
        expect(readMachineIdentity()).toMatchObject({ machineId: 'machine-1', machineKey: encodeBase64(machineKey) });
    });

    it('reads the account envelope and metadata version, and a missing machine as null', async () => {
        get.mockResolvedValueOnce({ data: { machine: { dataEncryptionKey: 'envelope', metadataVersion: 4 } } });
        await expect(io.fetchMachine('machine-1')).resolves.toEqual({ dataEncryptionKey: 'envelope', metadataVersion: 4 });
        expect(get).toHaveBeenCalledWith(
            `${configuration.serverUrl}/v1/machines/machine-1`,
            expect.objectContaining({ headers: { Authorization: 'Bearer token' } }),
        );

        get.mockRejectedValueOnce(httpError(404));
        await expect(io.fetchMachine('machine-1')).resolves.toBeNull();

        get.mockRejectedValueOnce(httpError(502));
        await expect(io.fetchMachine('machine-1')).rejects.toThrow('502');
    });

    it('reports a 409 from the swap as a conflict and anything else as it came', async () => {
        const request = { dataEncryptionKey: 'x' } as MachineKeyRotationRequest;

        post.mockResolvedValueOnce({ data: { ok: true } });
        await io.rotate('machine-1', request);
        expect(post).toHaveBeenCalledWith(
            `${configuration.serverUrl}/v1/machines/machine-1/key-rotation`,
            request,
            expect.objectContaining({ headers: { Authorization: 'Bearer token' } }),
        );

        post.mockRejectedValueOnce(httpError(409));
        await expect(io.rotate('machine-1', request)).rejects.toBeInstanceOf(MachineKeyRotationConflict);

        post.mockRejectedValueOnce(httpError(400));
        await expect(io.rotate('machine-1', request)).rejects.toThrow('400');
    });
});
