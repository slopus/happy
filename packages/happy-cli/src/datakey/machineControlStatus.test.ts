/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — what
 * `happy datakey status` reports and when `happy datakey harden` may switch.
 */
import { describe, expect, it } from 'vitest';
import { describeMachineControl, describeMachineKeyFingerprint, planHarden } from './machineControlStatus';
import { machineKeyFingerprint } from '@slopus/happy-wire';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const dataKey = (extra: Record<string, unknown> = {}) => ({ token: 't', encryption: { publicKey: key(2), machineKey: key(3), ...extra } });
const legacy = { token: 't', secret: key(1) };

describe('describeMachineControl', () => {
    it('reports strict in force only for a key the server was never sent', () => {
        expect(describeMachineControl({ mode: 'strict', rawCredentials: dataKey({ neverEscrowed: true }), rawPending: null }))
            .toEqual({ mode: 'strict', key: 'never-escrowed', pending: null, inForce: true });
        expect(describeMachineControl({ mode: 'strict', rawCredentials: dataKey(), rawPending: null }))
            .toEqual({ mode: 'strict', key: 'may-be-escrowed', pending: null, inForce: false });
    });

    it('never reports compat as in force, whatever the key', () => {
        expect(describeMachineControl({ mode: 'compat', rawCredentials: dataKey({ neverEscrowed: true }), rawPending: null }).inForce).toBe(false);
    });

    it('tells a legacy secret and missing credentials apart', () => {
        expect(describeMachineControl({ mode: 'strict', rawCredentials: legacy, rawPending: null }).key).toBe('account-secret');
        expect(describeMachineControl({ mode: 'strict', rawCredentials: null, rawPending: null }).key).toBe('none');
    });

    it('surfaces a pending rotation and why it last failed', () => {
        const status = describeMachineControl({
            mode: 'strict',
            rawCredentials: dataKey(),
            rawPending: {
                version: 1, machineId: 'm', fromKeySha256: 'a'.repeat(64), machineKey: key(9),
                dataEncryptionKey: 'e', serverRpcKeyEnvelope: null, lastError: 'ECONNREFUSED', lastAttemptAt: 5,
            },
        });

        expect(status.pending).toEqual({ lastError: 'ECONNREFUSED', lastAttemptAt: 5 });
        expect(status).not.toHaveProperty('pending.machineKey');
    });

    it('reports an unreadable pending record as pending without detail', () => {
        expect(describeMachineControl({ mode: 'strict', rawCredentials: dataKey(), rawPending: {} }).pending).toEqual({});
    });
});

describe('planHarden', () => {
    it('switches dataKey credentials from compat', () => {
        expect(planHarden({ mode: 'compat', rawCredentials: dataKey(), pendingExists: false }))
            .toEqual({ ok: true, markedStrict: false, dropNeverEscrowed: false, discardPending: false });
    });

    it('distrusts the marks compat left, which whoever held the machine key could have written', () => {
        expect(planHarden({ mode: 'compat', rawCredentials: dataKey({ neverEscrowed: true }), pendingExists: true }))
            .toEqual({ ok: true, markedStrict: false, dropNeverEscrowed: true, discardPending: true });
    });

    // The strict mark lives in settings.json, which compat leaves writable too: whoever held the
    // machine key could set it beside a key it knows, and a harden that trusted it would do nothing.
    it('distrusts a strict mark as well, since compat could have written it', () => {
        expect(planHarden({ mode: 'strict', rawCredentials: dataKey({ neverEscrowed: true }), pendingExists: true }))
            .toEqual({ ok: true, markedStrict: true, dropNeverEscrowed: true, discardPending: true });
    });

    it('refuses credentials whose machine key is the account secret', () => {
        expect(planHarden({ mode: 'compat', rawCredentials: legacy, pendingExists: false })).toEqual({ ok: false, reason: 'not-datakey' });
        expect(planHarden({ mode: 'compat', rawCredentials: { ...legacy, encryption: dataKey().encryption }, pendingExists: false }))
            .toEqual({ ok: false, reason: 'not-datakey' });
    });

    it('refuses missing credentials', () => {
        expect(planHarden({ mode: 'compat', rawCredentials: null, pendingExists: false })).toEqual({ ok: false, reason: 'no-credentials' });
    });
});

// aplus-dev-studio specs/e2ee-machine-control-boundary R20 — what a person compares with the
// fingerprint a client shows before attesting the key.
describe('describeMachineKeyFingerprint', () => {
    it('fingerprints the dataKey machine key for this machine', () => {
        expect(describeMachineKeyFingerprint({ rawCredentials: dataKey(), machineId: 'machine-1' }))
            .toBe(machineKeyFingerprint('machine-1', Buffer.alloc(32, 3)));
    });

    it('has nothing to show without a dataKey machine key or a machine id', () => {
        expect(describeMachineKeyFingerprint({ rawCredentials: legacy, machineId: 'machine-1' })).toBeNull();
        expect(describeMachineKeyFingerprint({ rawCredentials: null, machineId: 'machine-1' })).toBeNull();
        expect(describeMachineKeyFingerprint({ rawCredentials: dataKey(), machineId: undefined })).toBeNull();
    });
});
