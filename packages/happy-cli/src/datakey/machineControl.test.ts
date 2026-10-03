/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R4/R5 — what a daemon
 * does with its machine key before registering, by mode.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64, decrypt, deriveServerRpcKey, encodeBase64 } from '@/api/encryption';
import type { MachineMetadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import {
    MachineKeyRotationConflict,
    StrictMachineControlError,
    settleMachineControl,
    type MachineControlIo,
    type MachineKeyRotationRequest,
    type PendingMachineKeyRotation,
} from './machineControl';

const account = tweetnacl.box.keyPair();
const server = tweetnacl.box.keyPair();
const oldKey = new Uint8Array(32).fill(1);
const newKey = new Uint8Array(32).fill(9);
const metadata = { host: 'h', platform: 'darwin', happyCliVersion: 't', homeDir: '/h', happyHomeDir: '/h/.happy', happyLibDir: '/l' } as MachineMetadata;

const sha256 = (key: Uint8Array) => createHash('sha256').update(key).digest('hex');
const open = (bundle: string, secretKey: Uint8Array) => {
    const bytes = decodeBase64(bundle);
    return tweetnacl.box.open(bytes.slice(33 + 24), bytes.slice(33, 33 + 24), bytes.slice(1, 33), secretKey);
};

function dataKeyCredentials(machineKey = oldKey, neverEscrowed = false): Credentials {
    return {
        token: 'token',
        encryption: { type: 'dataKey', publicKey: account.publicKey, machineKey, ...(neverEscrowed ? { neverEscrowed: true as const } : {}) },
    };
}

function harness(options: {
    pending?: unknown;
    fetchMachine?: MachineControlIo['fetchMachine'];
    rotate?: MachineControlIo['rotate'];
} = {}) {
    const calls: string[] = [];
    const state = {
        pending: (options.pending ?? null) as unknown,
        written: null as Credentials | null,
        rotations: [] as Array<{ machineId: string; request: MachineKeyRotationRequest }>,
    };
    const io: MachineControlIo = {
        readPending: async () => state.pending,
        writePending: async (pending) => { calls.push('writePending'); state.pending = structuredClone(pending); },
        deletePending: async () => { calls.push('deletePending'); state.pending = null; },
        writeCredentials: async (credentials) => { calls.push('writeCredentials'); state.written = credentials; },
        fetchMachine: async (machineId) => {
            calls.push('fetchMachine');
            return options.fetchMachine ? options.fetchMachine(machineId) : { dataEncryptionKey: 'current-envelope', metadataVersion: 7 };
        },
        rotate: async (machineId, request) => {
            calls.push('rotate');
            state.rotations.push({ machineId, request });
            if (options.rotate) await options.rotate(machineId, request);
        },
        randomKey: () => newKey,
        now: () => 1_000,
    };
    return { io, calls, state };
}

function settle(h: ReturnType<typeof harness>, input: { mode: 'compat' | 'strict'; credentials: Credentials; serverPublicKey?: string | null }) {
    return settleMachineControl({
        mode: input.mode,
        credentials: input.credentials,
        machineId: 'machine-1',
        serverPublicKey: input.serverPublicKey === undefined ? encodeBase64(server.publicKey) : input.serverPublicKey,
        metadata,
        io: h.io,
    });
}

function pendingFrom(key: Uint8Array, overrides: Partial<PendingMachineKeyRotation> = {}): PendingMachineKeyRotation {
    return {
        version: 1,
        machineId: 'machine-1',
        fromKeySha256: sha256(key),
        machineKey: encodeBase64(newKey),
        dataEncryptionKey: 'pending-account-envelope',
        serverRpcKeyEnvelope: 'pending-server-lane-envelope',
        ...overrides,
    };
}

describe('settleMachineControl in compat mode', () => {
    it('leaves a dataKey machine key alone', async () => {
        const h = harness();
        const credentials = dataKeyCredentials();

        await expect(settle(h, { mode: 'compat', credentials })).resolves.toBe(credentials);
        expect(h.calls).toEqual([]);
    });

    it('leaves legacy credentials alone', async () => {
        const h = harness();
        const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } };

        await expect(settle(h, { mode: 'compat', credentials })).resolves.toBe(credentials);
        expect(h.calls).toEqual([]);
    });

    it('drops the never-escrowed mark before registration hands the server a copy', async () => {
        const h = harness();

        const settled = await settle(h, { mode: 'compat', credentials: dataKeyCredentials(oldKey, true) });

        expect(settled.encryption).not.toHaveProperty('neverEscrowed');
        expect(h.state.written).toEqual(settled);
        expect(h.calls).toEqual(['writeCredentials']);
    });

    it('keeps the mark when there is no server key to escrow to', async () => {
        const h = harness();
        const credentials = dataKeyCredentials(oldKey, true);

        await expect(settle(h, { mode: 'compat', credentials, serverPublicKey: null })).resolves.toBe(credentials);
        expect(h.calls).toEqual([]);
    });

    it('finishes a rotation a strict start left pending, without the mark', async () => {
        const h = harness({ pending: pendingFrom(oldKey) });

        const settled = await settle(h, { mode: 'compat', credentials: dataKeyCredentials() });

        expect(settled.encryption).toEqual({ type: 'dataKey', publicKey: account.publicKey, machineKey: newKey });
        expect(h.calls).toEqual(['fetchMachine', 'rotate', 'writeCredentials', 'deletePending']);
    });

    it('keeps the current key and the pending record when that rotation cannot finish', async () => {
        const h = harness({ pending: pendingFrom(oldKey), fetchMachine: async () => { throw new Error('offline'); } });
        const credentials = dataKeyCredentials();

        await expect(settle(h, { mode: 'compat', credentials })).resolves.toBe(credentials);
        expect(h.state.written).toBeNull();
        expect(h.state.pending).toMatchObject({ machineKey: encodeBase64(newKey), lastError: 'offline', lastAttemptAt: 1_000 });
    });
});

describe('settleMachineControl in strict mode', () => {
    it('refuses credentials whose machine key is the account secret', async () => {
        const h = harness();
        const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } };

        await expect(settle(h, { mode: 'strict', credentials })).rejects.toMatchObject({ reason: 'requires-datakey' });
        expect(h.calls).toEqual([]);
    });

    it('keeps a key that was never escrowed without asking the server', async () => {
        const h = harness();
        const credentials = dataKeyCredentials(oldKey, true);

        await expect(settle(h, { mode: 'strict', credentials })).resolves.toBe(credentials);
        expect(h.calls).toEqual([]);
    });

    it('replaces any other key, recording the replacement before the server sees it', async () => {
        const h = harness();

        const settled = await settle(h, { mode: 'strict', credentials: dataKeyCredentials() });

        expect(h.calls).toEqual(['writePending', 'fetchMachine', 'rotate', 'writeCredentials', 'deletePending']);
        expect(settled.encryption).toEqual({ type: 'dataKey', publicKey: account.publicKey, machineKey: newKey, neverEscrowed: true });
        expect(h.state.written).toEqual(settled);

        const [{ machineId, request }] = h.state.rotations;
        expect(machineId).toBe('machine-1');
        expect(request).toMatchObject({ expectedDataEncryptionKey: 'current-envelope', expectedMetadataVersion: 7, daemonState: null });
        expect(open(request.dataEncryptionKey, account.secretKey)).toEqual(newKey);
        expect(open(request.serverRpcKeyEnvelope!, server.secretKey)).toEqual(deriveServerRpcKey(newKey));
        expect(request).not.toHaveProperty('serverDataEncryptionKey');
        expect(decrypt(newKey, 'dataKey', decodeBase64(request.metadata))).toEqual(metadata);
    });

    it('rotates without a server lane when no server key is configured', async () => {
        const h = harness();

        await settle(h, { mode: 'strict', credentials: dataKeyCredentials(), serverPublicKey: null });

        expect(h.state.rotations[0].request.serverRpcKeyEnvelope).toBeNull();
    });

    it('only replaces the key locally when the server has no such machine', async () => {
        const h = harness({ fetchMachine: async () => null });

        const settled = await settle(h, { mode: 'strict', credentials: dataKeyCredentials() });

        expect(h.calls).toEqual(['writePending', 'fetchMachine', 'writeCredentials', 'deletePending']);
        expect(settled.encryption).toMatchObject({ machineKey: newKey, neverEscrowed: true });
    });

    it('refuses to start on the old key when the server cannot be reached', async () => {
        const h = harness({ fetchMachine: async () => { throw new Error('ECONNREFUSED'); } });

        const failure = await settle(h, { mode: 'strict', credentials: dataKeyCredentials() }).catch((error) => error);

        expect(failure).toBeInstanceOf(StrictMachineControlError);
        expect(failure.reason).toBe('rotation-failed');
        expect(h.state.written).toBeNull();
        expect(h.state.pending).toMatchObject({ fromKeySha256: sha256(oldKey), lastError: 'ECONNREFUSED' });
    });

    it('refuses to start when the server rejects the swap', async () => {
        const h = harness({ rotate: async () => { throw new Error('Request failed with status code 500'); } });

        await expect(settle(h, { mode: 'strict', credentials: dataKeyCredentials() })).rejects.toMatchObject({ reason: 'rotation-failed' });
        expect(h.state.written).toBeNull();
    });

    it('refuses to start when the server holds no account envelope to swap', async () => {
        const h = harness({ fetchMachine: async () => ({ dataEncryptionKey: null, metadataVersion: 0 }) });

        await expect(settle(h, { mode: 'strict', credentials: dataKeyCredentials() })).rejects.toMatchObject({ reason: 'rotation-failed' });
        expect(h.calls).not.toContain('rotate');
    });

    it('reads the server again after a conflicting write and retries', async () => {
        let attempts = 0;
        let version = 7;
        const h = harness({
            fetchMachine: async () => ({ dataEncryptionKey: 'current-envelope', metadataVersion: version }),
            rotate: async () => {
                attempts += 1;
                if (attempts === 1) { version = 8; throw new MachineKeyRotationConflict(); }
            },
        });

        await settle(h, { mode: 'strict', credentials: dataKeyCredentials() });

        expect(h.state.rotations.map(({ request }) => request.expectedMetadataVersion)).toEqual([7, 8]);
        expect(h.state.written?.encryption).toMatchObject({ machineKey: newKey });
    });

    it('gives up after repeated conflicts', async () => {
        const h = harness({ rotate: async () => { throw new MachineKeyRotationConflict(); } });

        await expect(settle(h, { mode: 'strict', credentials: dataKeyCredentials() })).rejects.toMatchObject({ reason: 'rotation-failed' });
        expect(h.state.rotations).toHaveLength(3);
        expect(h.state.written).toBeNull();
    });

    it('resumes a pending rotation with the same key and envelopes', async () => {
        const h = harness({ pending: pendingFrom(oldKey) });

        const settled = await settle(h, { mode: 'strict', credentials: dataKeyCredentials() });

        expect(h.calls).toEqual(['fetchMachine', 'rotate', 'writeCredentials', 'deletePending']);
        expect(h.state.rotations[0].request).toMatchObject({
            dataEncryptionKey: 'pending-account-envelope',
            serverRpcKeyEnvelope: 'pending-server-lane-envelope',
        });
        expect(settled.encryption).toMatchObject({ machineKey: newKey, neverEscrowed: true });
    });

    it('only clears a pending record whose key access.key already holds', async () => {
        const h = harness({ pending: pendingFrom(oldKey) });
        const credentials = dataKeyCredentials(newKey, true);

        await expect(settle(h, { mode: 'strict', credentials })).resolves.toBe(credentials);
        expect(h.calls).toEqual(['deletePending']);
    });

    it('discards a pending record for another key or machine and starts over', async () => {
        for (const stale of [pendingFrom(new Uint8Array(32).fill(5)), pendingFrom(oldKey, { machineId: 'machine-2' }), { version: 99 }]) {
            const h = harness({ pending: stale });

            await settle(h, { mode: 'strict', credentials: dataKeyCredentials() });

            expect(h.calls).toEqual(['deletePending', 'writePending', 'fetchMachine', 'rotate', 'writeCredentials', 'deletePending']);
        }
    });
});
