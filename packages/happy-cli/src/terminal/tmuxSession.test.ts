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

    it('recovers the recorded pane after the user splits panes', async () => {
        const terminalId = `split${Date.now()}`;
        const target = `happy-term-${terminalId}`;
        execFileSync(
            'tmux',
            ['new-session', '-d', '-s', target, '-c', process.cwd(), '/bin/sh'],
            { stdio: 'ignore' },
        );
        const recordedPane = execFileSync(
            'tmux',
            ['list-panes', '-t', target, '-F', '#{pane_id}'],
        ).toString().trim();

        try {
            // User splits panes while the managed shell keeps running.
            execFileSync('tmux', ['split-window', '-t', target], { stdio: 'ignore' });

            const recovered = await TmuxShellSession.create({
                terminalId,
                cwd: process.cwd(),
                shell: '/bin/sh',
                cols: 80,
                rows: 24,
                paneId: recordedPane,
            });
            expect(recovered.paneId).toBe(recordedPane);

            let output = '';
            recovered.onOutput((data) => {
                output += data;
            });
            recovered.write('echo split-ok\r');
            await waitFor(() => output.includes('split-ok'));
            await recovered.kill();
        } finally {
            try {
                execFileSync('tmux', ['kill-session', '-t', target], { stdio: 'ignore' });
            } catch {
                // Session may already be gone after recovered.kill().
            }
        }
    });

    it('falls back to the active pane when the recorded pane is gone', async () => {
        const terminalId = `fallback${Date.now()}`;
        const target = `happy-term-${terminalId}`;
        execFileSync(
            'tmux',
            ['new-session', '-d', '-s', target, '-c', process.cwd(), '/bin/sh'],
            { stdio: 'ignore' },
        );
        const recordedPane = execFileSync(
            'tmux',
            ['list-panes', '-t', target, '-F', '#{pane_id}'],
        ).toString().trim();

        try {
            execFileSync('tmux', ['split-window', '-t', target], { stdio: 'ignore' });
            execFileSync('tmux', ['kill-pane', '-t', recordedPane], { stdio: 'ignore' });

            const recovered = await TmuxShellSession.create({
                terminalId,
                cwd: process.cwd(),
                shell: '/bin/sh',
                cols: 80,
                rows: 24,
                paneId: recordedPane,
            });
            expect(recovered.paneId).not.toBe(recordedPane);
            expect(recovered.paneId).toMatch(/^%\d+$/);
            await recovered.kill();
        } finally {
            try {
                execFileSync('tmux', ['kill-session', '-t', target], { stdio: 'ignore' });
            } catch {
                // Session may already be gone after recovered.kill().
            }
        }
    });
});
