import { describe, expect, it } from 'vitest';

import { applyCliWarningDismissal, isCliWarningDismissed } from './cliWarnings';

describe('agents/cliWarnings', () => {
    it('marks a warning as dismissed globally', () => {
        const current = { perMachine: {}, global: {} };
        const next = applyCliWarningDismissal({
            dismissed: current,
            machineId: 'm1',
            warningKey: 'codex',
            scope: 'global',
        });

        expect(next.global.codex).toBe(true);
        expect(next.perMachine).toEqual({});
        expect(isCliWarningDismissed({ dismissed: next, machineId: 'm1', warningKey: 'codex' })).toBe(true);
        expect(isCliWarningDismissed({ dismissed: next, machineId: 'm2', warningKey: 'codex' })).toBe(true);
    });

    it('marks a warning as dismissed for a specific machine', () => {
        const current = { perMachine: {}, global: {} };
        const next = applyCliWarningDismissal({
            dismissed: current,
            machineId: 'm1',
            warningKey: 'codex',
            scope: 'machine',
        });

        expect(next.global).toEqual({});
        expect(next.perMachine.m1?.codex).toBe(true);
        expect(isCliWarningDismissed({ dismissed: next, machineId: 'm1', warningKey: 'codex' })).toBe(true);
        expect(isCliWarningDismissed({ dismissed: next, machineId: 'm2', warningKey: 'codex' })).toBe(false);
    });
});

