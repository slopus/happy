import { describe, it, expect } from 'vitest';

describe('daemon tmux spawn config', () => {
    const originalRuntimeOverride = process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
    const originalPath = process.env.PATH;

    it('uses merged env and bun runtime when configured', async () => {
        process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = 'bun';
        process.env.PATH = '/bin';

        try {
            const runModule = (await import('@/daemon/run')) as typeof import('@/daemon/run');
            const cfg = runModule.buildTmuxSpawnConfig({
                agent: 'claude',
                directory: '/tmp',
                extraEnv: {
                    FOO: 'bar',
                },
                tmuxCommandEnv: {
                    TMUX_TMPDIR: '/custom/tmux',
                },
                extraArgs: ['--happy-terminal-mode', 'tmux'],
            });

            expect(cfg.commandTokens[0]).toBe('bun');
            expect(cfg.tmuxEnv.PATH).toBe('/bin');
            expect(cfg.tmuxEnv.FOO).toBe('bar');
            expect(cfg.tmuxCommandEnv.TMUX_TMPDIR).toBe('/custom/tmux');
            expect(cfg.commandTokens).toEqual(expect.arrayContaining(['--happy-terminal-mode', 'tmux']));
        } finally {
            if (originalRuntimeOverride === undefined) {
                delete process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
            } else {
                process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
            }
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
        }
    }, 15000);
});
