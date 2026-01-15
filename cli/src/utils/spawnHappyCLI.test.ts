import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(() => ({ pid: 123 } as any)),
}));

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

describe('spawnHappyCLI', () => {
    const originalRuntimeOverride = process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;

    beforeEach(() => {
        spawnMock.mockClear();
        delete process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
    });

    afterEach(() => {
        if (originalRuntimeOverride === undefined) {
            delete process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
        } else {
            process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
        }
    });

    it('spawns with node by default', async () => {
        const { spawnHappyCLI } = await import('./spawnHappyCLI');

        spawnHappyCLI(['--version'], { stdio: 'pipe' });

        expect(spawnMock).toHaveBeenCalledWith(
            'node',
            expect.arrayContaining(['--no-warnings', '--no-deprecation', expect.stringMatching(/dist\/index\.mjs$/), '--version']),
            expect.objectContaining({ stdio: 'pipe' }),
        );
    });

    it('spawns with bun when configured via HAPPY_CLI_SUBPROCESS_RUNTIME=bun', async () => {
        process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = 'bun';

        const { spawnHappyCLI } = await import('./spawnHappyCLI');

        spawnHappyCLI(['--version'], { stdio: 'pipe' });

        expect(spawnMock).toHaveBeenCalledWith(
            'bun',
            expect.arrayContaining([expect.stringMatching(/dist\/index\.mjs$/), '--version']),
            expect.objectContaining({ stdio: 'pipe' }),
        );

        const argv = (spawnMock.mock.calls[0] as any)?.[1] as string[];
        expect(argv).not.toContain('--no-warnings');
        expect(argv).not.toContain('--no-deprecation');
    });
});
