import { describe, expect, it } from 'vitest';
import { chooseTerminalBackend } from './terminalTransport';
import { PtyTerminalTransport } from './ptyTerminalTransport';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';

describe('chooseTerminalBackend', () => {
    it('prefers configured and available tmux over pty', () => {
        expect(chooseTerminalBackend({
            tmux: { configured: true, available: true },
            pty: { available: true },
        })).toEqual({ supported: true, backend: 'tmux' });
    });

    it('falls back to pty when tmux is unavailable', () => {
        expect(chooseTerminalBackend({
            tmux: { configured: true, available: false },
            pty: { available: true },
        })).toEqual({ supported: true, backend: 'pty' });
    });

    it('falls back to pty when tmux is not configured', () => {
        expect(chooseTerminalBackend({
            tmux: { configured: false, available: true },
            pty: { available: true },
        })).toEqual({ supported: true, backend: 'pty' });
    });

    it('reports unsupported when neither backend can run', () => {
        expect(chooseTerminalBackend({
            tmux: { configured: true, available: false },
            pty: { available: false },
        })).toEqual({ supported: false, backend: 'unsupported' });
    });
});

describe('terminal transport capabilities', () => {
    it('exposes tmux backend capabilities', () => {
        const transport = new TmuxTerminalTransport();

        expect(transport.backend).toBe('tmux');
        expect(transport.capabilities).toEqual(['remote-control', 'local-attach']);
    });

    it('exposes pty backend capabilities', () => {
        const transport = new PtyTerminalTransport();

        expect(transport.backend).toBe('pty');
        expect(transport.capabilities).toEqual(['remote-control']);
    });
});
