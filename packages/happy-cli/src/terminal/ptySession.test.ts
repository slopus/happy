import { describe, expect, it } from 'vitest';
import { PtyShellSession } from './ptySession';

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
                reject(new Error('Timed out waiting for condition'));
            }
        }, 20);
    });
}

describe('PtyShellSession', () => {
    it('spawns a shell, forwards output, and provides an ANSI snapshot', async () => {
        const session = new PtyShellSession({
            cwd: process.cwd(),
            shell: process.env.SHELL || '/bin/sh',
            cols: 80,
            rows: 24,
        });

        let output = '';
        session.onOutput((data) => {
            output += data;
        });

        session.write('printf "pty-hello-123\\n"\r');
        await waitFor(() => output.includes('pty-hello-123'));

        // The flush barrier guarantees the snapshot already includes output
        // that was emitted, without relying on a timeout.
        const snapshot = await session.snapshot();
        expect(snapshot).toContain('pty-hello-123');

        await session.kill();
    });

    it('supports resize and transport pause/resume', () => {
        const session = new PtyShellSession({
            cwd: process.cwd(),
            shell: process.env.SHELL || '/bin/sh',
            cols: 80,
            rows: 24,
        });
        expect(() => session.resize(120, 40)).not.toThrow();
        expect(() => session.pause()).not.toThrow();
        expect(() => session.resume()).not.toThrow();
        void session.kill();
    });
});
