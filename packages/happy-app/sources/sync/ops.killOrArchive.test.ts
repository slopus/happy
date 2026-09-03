import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC, request } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    request: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC, request } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: {} }));

describe('sessionKillOrArchive', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        request.mockReset();
    });

    it('kills the CLI process and never archives when the kill succeeds', async () => {
        sessionRPC.mockResolvedValue({ success: true, message: 'Killing happy-cli process' });

        const { sessionKillOrArchive } = await import('./ops');
        await expect(sessionKillOrArchive('session-1')).resolves.toBeUndefined();

        expect(sessionRPC).toHaveBeenCalledWith('session-1', 'killSession', {});
        expect(request).not.toHaveBeenCalled();
    });

    it('falls back to the server-side archive when the CLI process is unreachable', async () => {
        sessionRPC.mockRejectedValue(new Error('RPC method not available'));
        request.mockResolvedValue({ ok: true, status: 200 });

        const { sessionKillOrArchive } = await import('./ops');
        await expect(sessionKillOrArchive('session-1')).resolves.toBeUndefined();

        expect(request).toHaveBeenCalledWith('/v1/sessions/session-1/archive', { method: 'POST' });
    });

    it('throws when both the kill RPC and the server archive fail', async () => {
        sessionRPC.mockResolvedValue({ success: false, message: 'The computer did not respond' });
        request.mockResolvedValue({ ok: false, status: 503 });

        const { sessionKillOrArchive } = await import('./ops');
        await expect(sessionKillOrArchive('session-1')).rejects.toThrow('Server error: 503');
    });

    it('throws the kill error path when the archive request itself rejects', async () => {
        sessionRPC.mockResolvedValue({ success: false, message: 'The computer did not respond' });
        request.mockRejectedValue(new Error('Network down'));

        const { sessionKillOrArchive } = await import('./ops');
        await expect(sessionKillOrArchive('session-1')).rejects.toThrow('Network down');
    });
});
