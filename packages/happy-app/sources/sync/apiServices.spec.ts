import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectService } from './apiServices';
import { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com'
}));

vi.mock('@/utils/time', () => ({
    backoff: vi.fn((fn) => fn())
}));

describe('apiServices', () => {
    const mockCredentials: AuthCredentials = {
        token: 'test-token',
        secret: 'test-secret'
    };

    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('supports the legacy immediate success response', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ success: true })
        });

        await expect(connectService(mockCredentials, 'openai', { oauth: true })).resolves.toBeUndefined();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('waits for the long-task response to complete', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 202,
                json: vi.fn().mockResolvedValue({
                    taskId: 'task-1',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({
                    taskId: 'task-1',
                    state: 'succeeded',
                    stage: 'succeeded',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.100Z',
                    updatedAt: '2026-01-01T00:00:00.100Z'
                })
            });

        await expect(connectService(mockCredentials, 'anthropic', { oauth: true })).resolves.toBeUndefined();
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            'https://api.test.com/v1/tasks/task-1',
            {
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer test-token',
                    'Content-Type': 'application/json'
                }
            }
        );
    });

    it('surfaces a clearer error when the long-task record is lost', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 202,
                json: vi.fn().mockResolvedValue({
                    taskId: 'task-2',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: vi.fn()
            });

        await expect(connectService(mockCredentials, 'gemini', { oauth: true }))
            .rejects.toThrow('Service connection task was lost before completion. Please retry.');
    });
});
