import { describe, expect, it } from 'vitest';
import { SessionMessageLoadGate } from './sessionMessageLoadGate';

describe('SessionMessageLoadGate', () => {
    it('makes an in-flight operation stale when its session is invalidated', () => {
        const gate = new SessionMessageLoadGate();
        const lease = gate.enter('session-a');
        const inFlight = gate.begin(lease);

        gate.invalidate('session-a');
        const replacementLease = gate.enter('session-a');
        const replacement = gate.begin(replacementLease);

        expect(gate.isCurrent(inFlight)).toBe(false);
        expect(gate.isCurrent(replacement)).toBe(true);
        expect(() => gate.assertCurrent(inFlight)).toThrow('abandoned');
    });

    it('does not let an old same-session leave cancel a newer operation', () => {
        const gate = new SessionMessageLoadGate();
        const oldLease = gate.enter('session-a');
        const oldOperation = gate.begin(oldLease);
        const newLease = gate.enter('session-a');
        const newOperation = gate.begin(newLease);

        gate.leave(oldLease);

        expect(gate.isCurrent(newOperation)).toBe(true);
        gate.leave(newLease);
        expect(gate.isCurrent(newOperation)).toBe(false);
    });

    it('keeps the lease current when a newer load supersedes an older load', () => {
        const gate = new SessionMessageLoadGate();
        const lease = gate.enter('session-a');
        const oldLoad = gate.begin(lease);
        const newLoad = gate.begin(lease);

        expect(gate.isCurrent(oldLoad)).toBe(false);
        expect(gate.isCurrent(newLoad)).toBe(true);
        expect(gate.isLeaseCurrent(lease)).toBe(true);

        gate.leave(lease);
        expect(gate.isCurrent(newLoad)).toBe(false);
    });
});
