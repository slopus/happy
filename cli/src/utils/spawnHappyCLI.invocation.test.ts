/**
 * Tests for building happy-cli subprocess invocations across runtimes (node/bun).
 */
import { afterEach, describe, it, expect } from 'vitest';

describe('happy-cli subprocess invocation', () => {
    const originalRuntimeOverride = process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;

    afterEach(() => {
        if (originalRuntimeOverride === undefined) {
            delete process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
        } else {
            process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
        }
    });

    it('builds a node invocation by default', async () => {
        delete process.env.HAPPY_CLI_SUBPROCESS_RUNTIME;
        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');

        const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
        expect(inv.runtime).toBe('node');
        expect(inv.argv).toEqual(
            expect.arrayContaining([
                '--no-warnings',
                '--no-deprecation',
                expect.stringMatching(/dist\/index\.mjs$/),
                '--version',
            ]),
        );
    });

    it('builds a bun invocation when HAPPY_CLI_SUBPROCESS_RUNTIME=bun', async () => {
        process.env.HAPPY_CLI_SUBPROCESS_RUNTIME = 'bun';
        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        const inv = mod.buildHappyCliSubprocessInvocation(['--version']);
        expect(inv.runtime).toBe('bun');
        expect(inv.argv).toEqual(expect.arrayContaining([expect.stringMatching(/dist\/index\.mjs$/), '--version']));
        expect(inv.argv).not.toContain('--no-warnings');
        expect(inv.argv).not.toContain('--no-deprecation');
    });
});
