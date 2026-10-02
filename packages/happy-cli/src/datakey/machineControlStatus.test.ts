/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — what
 * `happy datakey status` reports and when `happy datakey harden` may switch.
 */
import { describe, expect, it } from 'vitest';
import { describeMachineControl, planHarden } from './machineControlStatus';

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
    it('switches dataKey credentials', () => {
        expect(planHarden({ rawCredentials: dataKey() })).toEqual({ ok: true });
    });

    it('refuses credentials whose machine key is the account secret', () => {
        expect(planHarden({ rawCredentials: legacy })).toEqual({ ok: false, reason: 'not-datakey' });
        expect(planHarden({ rawCredentials: { ...legacy, encryption: dataKey().encryption } })).toEqual({ ok: false, reason: 'not-datakey' });
    });

    it('refuses missing credentials', () => {
        expect(planHarden({ rawCredentials: null })).toEqual({ ok: false, reason: 'no-credentials' });
    });
});
