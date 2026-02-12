import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '..', 'bin', 'happy-agent.mjs');

function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
        const stdout = execFileSync(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            ...args,
        ], { encoding: 'utf-8', env: { ...process.env, HAPPY_HOME_DIR: '/tmp/nonexistent-happy-test' } });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: e.status ?? 1,
        };
    }
}

describe('happy-agent CLI', () => {
    it('should display help output', () => {
        const { stdout } = runCli('--help');
        expect(stdout).toContain('happy-agent');
        expect(stdout).toContain('CLI client for controlling Happy Coder agents remotely');
    });

    it('should display version', () => {
        const { stdout } = runCli('--version');
        expect(stdout.trim()).toBe('0.1.0');
    });

    it('should list all expected commands in help', () => {
        const { stdout } = runCli('--help');
        expect(stdout).toContain('auth');
        expect(stdout).toContain('list');
        expect(stdout).toContain('status');
        expect(stdout).toContain('create');
        expect(stdout).toContain('send');
        expect(stdout).toContain('history');
        expect(stdout).toContain('stop');
        expect(stdout).toContain('wait');
    });

    describe('list command', () => {
        it('should show list help with --active and --json options', () => {
            const { stdout } = runCli('list', '--help');
            expect(stdout).toContain('List all sessions');
            expect(stdout).toContain('--active');
            expect(stdout).toContain('--json');
        });

        it('should fail with auth error when not authenticated', () => {
            const { stderr, exitCode } = runCli('list');
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('happy-agent auth login');
        });
    });

    describe('status command', () => {
        it('should show status help with session-id argument and --json option', () => {
            const { stdout } = runCli('status', '--help');
            expect(stdout).toContain('session-id');
            expect(stdout).toContain('--json');
        });

        it('should fail with auth error when not authenticated', () => {
            const { stderr, exitCode } = runCli('status', 'fake-session-id');
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('happy-agent auth login');
        });
    });
});
