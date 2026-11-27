import { describe, expect, it, vi } from 'vitest';
import { awaitNativeProcessGroupExit, hasIsolatedNativeProcessGroup } from './nativeProcessGroup';
describe('native process ownership and exit', () => {
    it('accepts only a detached wrapper whose entire observed descendant tree shares its group', () => {
        expect(hasIsolatedNativeProcessGroup(100, '100 1 100\n101 100 100\n102 101 100\n200 1 200')).toBe(true);
        expect(hasIsolatedNativeProcessGroup(100, '100 1 99\n101 100 99')).toBe(false);
        expect(hasIsolatedNativeProcessGroup(100, '100 1 100\n101 100 101')).toBe(false);
        expect(hasIsolatedNativeProcessGroup(100, '101 1 100')).toBe(false);
    });
    it('waits for the entire native group and never sends another termination signal', async () => {
        vi.useFakeTimers();
        const probe = vi.spyOn(process, 'kill').mockImplementationOnce(() => true).mockImplementation(() => {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        });
        try {
            const waiting = awaitNativeProcessGroupExit(100);
            await vi.advanceTimersByTimeAsync(100); await waiting;
            expect(probe.mock.calls).toEqual([[-100, 0], [-100, 0]]);
        } finally { probe.mockRestore(); vi.useRealTimers(); }
    });
    it('fails closed when the native group survives its wrapper', async () => {
        vi.useFakeTimers(); const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
        try {
            const waiting = expect(awaitNativeProcessGroupExit(100)).rejects.toThrow('not exited');
            await vi.advanceTimersByTimeAsync(5000); await waiting;
            expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        } finally { probe.mockRestore(); vi.useRealTimers(); }
    });
});
