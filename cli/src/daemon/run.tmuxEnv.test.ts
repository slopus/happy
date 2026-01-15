import { describe, it, expect } from 'vitest';

describe('daemon tmux env building', () => {
    it('merges daemon process env and profile env for tmux windows', async () => {
        const runModule = (await import('@/daemon/run')) as typeof import('@/daemon/run');
        const merged = runModule.buildTmuxWindowEnv(
            { PATH: '/bin', HOME: '/home/user', UNDEFINED: undefined },
            { HOME: '/override', CUSTOM: 'x' }
        );

        expect(merged.PATH).toBe('/bin');
        expect(merged.HOME).toBe('/override');
        expect(merged.CUSTOM).toBe('x');
        expect('UNDEFINED' in merged).toBe(false);
    }, 15000);
});
