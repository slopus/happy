import { describe, expect, it } from 'vitest';
import { SessionRouteOwnership } from './sessionRouteOwnership';

describe('session route ownership', () => {
    it('distinguishes switches and initial retries from same-session detail returns', () => {
        const owners = new SessionRouteOwnership();
        const first = owners.enter('a');
        expect(first.initialPosition).toBe('latest');
        owners.leave(first);
        const retry = owners.enter('a');
        expect(retry.initialPosition).toBe('latest');
        owners.opened(first); // A stale completion cannot consume this entry.
        expect(owners.enter('a').initialPosition).toBe('latest');
        owners.opened(owners.current()!);
        owners.leave(owners.current()!);
        expect(owners.enter('a').initialPosition).toBe('restore');
        expect(owners.enter('b').initialPosition).toBe('latest');
        expect(owners.enter('a').initialPosition).toBe('latest');
        owners.opened(owners.current()!);
        owners.resetEntryPosition();
        expect(owners.enter('a').initialPosition).toBe('latest');
    });
    it('ignores stale cleanup across route switches and same-session remounts', () => {
        const owners = new SessionRouteOwnership();
        const a = owners.enter('a');
        const b = owners.enter('b');
        expect(owners.leave(a)).toBe(false);
        expect(owners.current()).toBe(b);
        const newB = owners.enter('b');
        expect(owners.leave(b)).toBe(false);
        expect(owners.current()).toBe(newB);
        expect(owners.owns(a)).toBe(false);
        expect(owners.ownsSession('b')).toBe(true);
        expect(owners.leave(newB)).toBe(true);
        expect(owners.current()).toBeNull();
    });

    it('promotes only the current epoch while preserving its cleanup capability', () => {
        const owners = new SessionRouteOwnership();
        const old = owners.enter('a');
        const current = owners.enter('a');
        expect(owners.promote(old)).toBeNull();
        expect(owners.promote(current)).toEqual({ ...current, phase: 'interactive' });
        expect(current.phase).toBe('opening');
        expect(owners.owns(current)).toBe(true);
        expect(owners.leave(current)).toBe(true);
        expect(owners.promote(current)).toBeNull();
    });

    it('terminalizes only the current epoch while preserving its cleanup capability', () => {
        const owners = new SessionRouteOwnership();
        const old = owners.enter('a');
        const current = owners.enter('a');

        expect(owners.terminalize(old)).toBeNull();
        expect(owners.terminalize(current)).toEqual({ ...current, phase: 'terminal' });
        expect(owners.owns(current)).toBe(true);
        expect(owners.promote(current)).toBeNull();
        expect(owners.leave(current)).toBe(true);
    });
});
