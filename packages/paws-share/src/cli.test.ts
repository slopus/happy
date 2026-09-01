import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        io: {
            stdout: (value) => stdout.push(value),
            stderr: (value) => stderr.push(value),
        },
    };
}

describe('paws-share CLI', () => {
    it('prints a stable version without reading records or provider stores', async () => {
        const output = capture();

        const exitCode = await runCli(['node', 'paws-share', '--version'], output.io);

        expect(exitCode).toBe(0);
        expect(output.stdout.join('')).toBe('0.1.0-beta.0\n');
        expect(output.stderr).toEqual([]);
    });

    it('documents the session sharing management commands', async () => {
        const output = capture();

        const exitCode = await runCli(['node', 'paws-share', '--help'], output.io);

        expect(exitCode).toBe(0);
        expect(output.stdout.join('')).toContain('inspect');
        expect(output.stdout.join('')).toContain('share');
        expect(output.stdout.join('')).toContain('list');
        expect(output.stdout.join('')).toContain('renew');
        expect(output.stdout.join('')).toContain('revoke');
        expect(output.stderr).toEqual([]);
    });
});
