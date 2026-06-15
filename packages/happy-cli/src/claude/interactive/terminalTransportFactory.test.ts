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
            ANTHROPIC_API_KEY: 'anthropic-key',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
            CUSTOM_SECRET: 'custom-secret',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'reconnect-key',
            HAPPY_SERVER_URL: 'https://happy.example',
            HOME: '/Users/devdvlive',
            MCP_CONNECTION_NONBLOCKING: '1',
            PATH: '/opt/bin:/usr/bin',
            TMUX: '/tmp/tmux-501/default,123,0',
            TMUX_SESSION_NAME: 'happy',
        });

        expect(transport?.backend).toBe('tmux');
        expect(mockIsTmuxAvailable).toHaveBeenCalledOnce();
        expect(mockIsTmuxAvailable).toHaveBeenCalledWith({
            HOME: '/Users/devdvlive',
            PATH: '/opt/bin:/usr/bin',
            TMUX: '/tmp/tmux-501/default,123,0',
        });
        expect((transport as any).tmux.clientEnv).toEqual({
            HOME: '/Users/devdvlive',
            PATH: '/opt/bin:/usr/bin',
            TMUX: '/tmp/tmux-501/default,123,0',
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
