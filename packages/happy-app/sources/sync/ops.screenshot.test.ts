import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC },
}));

describe('requestScreenshot', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
    });

    it('requests the only supported full-desktop capture without target configuration', async () => {
        sessionRPC.mockResolvedValue({
            success: true,
            dataBase64: 'AAA',
            mimeType: 'image/jpeg',
        });

        const { requestScreenshot } = await import('./ops.screenshot');
        await requestScreenshot('session-1');

        expect(sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'screenshot',
            expect.any(Object),
        );
        expect(Object.keys(sessionRPC.mock.calls[0][2])).toEqual([]);
    });
});
