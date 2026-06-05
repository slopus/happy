import { describe, expect, it } from 'vitest';
import { ApiUpdateSchema, ApiUpdateContainerSchema } from './apiTypes';

describe('ApiUpdateSchema', () => {
    it('accepts shared wire update-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'update-session',
            id: 'session-1',
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts app-local new-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-session',
            id: 'session-2',
            createdAt: 1,
            updatedAt: 1,
        });
        expect(parsed.success).toBe(true);
    });

    // Regression: cold-onboarding "machine never shows up / can't start a new
    // session until app restart". When a machine is created, the server emits a
    // `new-machine` update (the only creation signal the user's app receives —
    // the `update-machine` companion is machine-scoped-only). Sync.handleUpdate
    // validates every update with ApiUpdateContainerSchema.safeParse() and
    // returns early on failure, so an unrecognized `new-machine` body is silently
    // dropped and the machine only appears after a full fetchMachines (restart /
    // socket reconnect). The body shape mirrors server buildNewMachineUpdate().
    it('accepts the server new-machine update body', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-machine',
            machineId: 'machine-1',
            seq: 1,
            metadata: 'encrypted-metadata',
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: 'base64-key',
            active: false,
            activeAt: 1700000000000,
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts a full new-machine update container (the handleUpdate validation gate)', () => {
        const parsed = ApiUpdateContainerSchema.safeParse({
            id: 'update-1',
            seq: 42,
            createdAt: 1700000000000,
            body: {
                t: 'new-machine',
                machineId: 'machine-1',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                activeAt: 1700000000000,
                createdAt: 1700000000000,
                updatedAt: 1700000000000,
            },
        });
        expect(parsed.success).toBe(true);
    });
});

