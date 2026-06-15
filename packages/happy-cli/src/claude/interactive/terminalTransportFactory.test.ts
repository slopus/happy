import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsTmuxAvailable = vi.hoisted(() => vi.fn());

vi.mock('@/utils/tmux', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/tmux')>();
    return {
        ...actual,
        isTmuxAvailable: mockIsTmuxAvailable,
    };
});

import { createTerminalTransport } from './terminalTransportFactory';

describe('createTerminalTransport', () => {
    beforeEach(() => {
        mockIsTmuxAvailable.mockReset();
        mockIsTmuxAvailable.mockResolvedValue(true);
    });

    it('uses tmux only when TMUX_SESSION_NAME is non-empty', async () => {
        const transport = await createTerminalTransport({
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            CUSTOM_SECRET: 'custom-secret',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'reconnect-key',
            HAPPY_SERVER_URL: 'https://happy.example',
            PATH: '/opt/bin:/usr/bin',
            TMUX_SESSION_NAME: 'happy',
        });

        expect(transport?.backend).toBe('tmux');
        expect(mockIsTmuxAvailable).toHaveBeenCalledOnce();
        expect(mockIsTmuxAvailable).toHaveBeenCalledWith({
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            PATH: '/opt/bin:/usr/bin',
        });
    });

    it('trims TMUX_SESSION_NAME before creating tmux transport', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: ' happy ' });

        expect(transport?.backend).toBe('tmux');
        expect((transport as any).sessionName).toBe('happy');
    });

    it('uses pty when TMUX_SESSION_NAME is absent even if tmux is available', async () => {
        const transport = await createTerminalTransport({});

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
        expect(mockIsTmuxAvailable).not.toHaveBeenCalled();
    });

    it('uses pty when TMUX_SESSION_NAME is empty even if tmux is available', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: '' });

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
        expect(mockIsTmuxAvailable).not.toHaveBeenCalled();
    });

    it('uses pty when TMUX_SESSION_NAME is whitespace even if tmux is available', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: '   ' });

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
        expect(mockIsTmuxAvailable).not.toHaveBeenCalled();
    });
});
