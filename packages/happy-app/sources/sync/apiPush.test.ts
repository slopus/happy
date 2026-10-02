import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { registerPushToken, unregisterPushToken } from './apiPush';

const credentials = { token: 'test-auth-token', secret: 'test-secret' };

describe('registerPushToken', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('sends a successful registration once', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as Response);

        await registerPushToken(credentials, 'ExponentPushToken[current-device]');

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith('https://paws.example/v1/push-tokens', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ token: 'ExponentPushToken[current-device]' }),
        }));
    });

    it('fails immediately on an authentication error', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

        await expect(registerPushToken(credentials, 'ExponentPushToken[current-device]'))
            .rejects.toThrow('HTTP 401');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('deletes an old token without sending a request body', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as Response);

        await unregisterPushToken(credentials, 'ExponentPushToken[old-device]');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://paws.example/v1/push-tokens/ExponentPushToken%5Bold-device%5D',
            expect.objectContaining({ method: 'DELETE', body: undefined }),
        );
    });

    it('stops retrying when the Paws server request never settles', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockImplementation(() => new Promise(() => {}));

        const result = registerPushToken(credentials, 'ExponentPushToken[current-device]');
        const failure = expect(result).rejects.toThrow('Paws server push token registration timed out');
        await vi.advanceTimersByTimeAsync(40_000);

        await failure;
        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const [, options] of fetchMock.mock.calls) {
            expect(options?.signal?.aborted).toBe(true);
        }
    });
});
