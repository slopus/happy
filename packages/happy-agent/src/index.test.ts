import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '..', 'bin', 'happy-agent.mjs');

describe('happy-agent CLI', () => {
    it('should display help output', () => {
        const output = execFileSync(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            '--help',
        ], { encoding: 'utf-8' });

        expect(output).toContain('happy-agent');
        expect(output).toContain('CLI client for controlling Happy Coder agents remotely');
    });

    it('should display version', () => {
        const output = execFileSync(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            '--version',
        ], { encoding: 'utf-8' });

        expect(output.trim()).toBe('0.1.0');
    });

    it('should list all expected commands in help', () => {
        const output = execFileSync(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            '--help',
        ], { encoding: 'utf-8' });

        expect(output).toContain('auth');
        expect(output).toContain('list');
        expect(output).toContain('status');
        expect(output).toContain('create');
        expect(output).toContain('send');
        expect(output).toContain('history');
        expect(output).toContain('stop');
        expect(output).toContain('wait');
    });
});
