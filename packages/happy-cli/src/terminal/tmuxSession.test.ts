import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { TmuxShellSession, unescapeControlOutput } from './tmuxSession';

function tmuxAvailable(): boolean {
    try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error('Timed out waiting for tmux output'));
            }
        }, 20);
    });
}

describe('tmux control output unescaping', () => {
    it('decodes octal escapes used by tmux control mode', () => {
        expect(unescapeControlOutput('hi\\015\\012')).toBe('hi\r\n');
        expect(unescapeControlOutput('\\033[?2004h')).toBe('\x1b[?2004h');
        expect(unescapeControlOutput('a\\134b')).toBe('a\\b');
        expect(unescapeControlOutput('plain')).toBe('plain');
    });
});

describe.skipIf(!tmuxAvailable())('TmuxShellSession', () => {
    it('runs a shell in a detached session and streams output', async () => {
        const terminalId = `test${Date.now()}`;
        const session = await TmuxShellSession.create({
            terminalId,
            cwd: process.cwd(),
            shell: '/bin/sh',
            cols: 80,
            rows: 24,
        });

        let output = '';
        session.onOutput((data) => {
            output += data;
        });

        session.write('echo tmux-hello-456\r');
        await waitFor(() => output.includes('tmux-hello-456'));

        const snapshot = await session.snapshot();
        expect(snapshot).toContain('tmux-hello-456');

        session.resize(100, 30);
        await session.kill();
    });
});
