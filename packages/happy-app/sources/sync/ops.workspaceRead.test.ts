import { expect, it, vi } from 'vitest';

const { sessionRPC } = vi.hoisted(() => ({ sessionRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC } }));
vi.mock('./sync', () => ({ sync: {} }));

it('bounds the whole file read including encryption and response handling', async () => {
    sessionRPC.mockResolvedValue({ success: true, content: '' });
    const { sessionWorkspaceReadFile } = await import('./ops');
    expect(await sessionWorkspaceReadFile('session', '/project/doc.md')).toEqual({ success: true, content: '' });
    expect(sessionRPC).toHaveBeenCalledWith('session', 'workspaceReadFile', { path: '/project/doc.md' }, {
        timeoutMs: 10_000, overallTimeoutMs: 10_000,
    });
});
