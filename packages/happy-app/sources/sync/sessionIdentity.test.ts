import { describe, expect, it } from 'vitest';
import { indexSessionsById } from './sessionIdentity';

describe('session identity', () => {
    it('keeps sessions from multiple daemons distinct even when auth and machine metadata match', () => {
        const indexed = indexSessionsById([
            { id: 'native-session', accountId: 'same-account', machineId: 'same-machine', daemon: 'happy' },
            { id: 'rig-session', accountId: 'same-account', machineId: 'same-machine', daemon: 'rig' },
        ]);
        expect(Object.keys(indexed)).toEqual(['native-session', 'rig-session']);
        expect(indexed['native-session'].daemon).toBe('happy');
        expect(indexed['rig-session'].daemon).toBe('rig');
    });
});
