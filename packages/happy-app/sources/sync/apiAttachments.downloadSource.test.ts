import type { AuthCredentials } from '@/auth/tokenStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAttachmentDownloadSource } from './apiAttachments';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test',
}));
vi.mock('@/auth/tokenStorage', () => ({}));
vi.mock('./uploadFormFile', () => ({ appendFormFile: vi.fn() }));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('requestAttachmentDownloadSource', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shares one request-download call for concurrent consumers', async () => {
        const response = deferred<Response>();
        const fetchMock = vi.fn<typeof fetch>();
        fetchMock.mockReturnValue(response.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');
        const second = requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        response.resolve(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            { uri: 'https://objects.test/file-1', headers: {} },
            { uri: 'https://objects.test/file-1', headers: {} },
        ]);
    });

    it('removes a rejected request so a later retry fetches again', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(requestAttachmentDownloadSource(credentials, 'session-1', 'file-1'))
            .rejects.toThrow('temporary failure');
        await expect(requestAttachmentDownloadSource(credentials, 'session-1', 'file-1'))
            .resolves.toEqual({ uri: 'https://objects.test/file-1', headers: {} });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetches again for a sequential request after the first one succeeds', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }))
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }));
        vi.stubGlobal('fetch', fetchMock);

        await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');
        await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce distinct session and ref tuples that share a delimiter', async () => {
        const firstResponse = deferred<Response>();
        const secondResponse = deferred<Response>();
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(firstResponse.promise)
            .mockReturnValueOnce(secondResponse.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = requestAttachmentDownloadSource(credentials, 'session:a', 'ref');
        const second = requestAttachmentDownloadSource(credentials, 'session', 'a:ref');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        firstResponse.resolve(jsonResponse({ downloadUrl: 'https://objects.test/first' }));
        secondResponse.resolve(jsonResponse({ downloadUrl: 'https://objects.test/second' }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            { uri: 'https://objects.test/first', headers: {} },
            { uri: 'https://objects.test/second', headers: {} },
        ]);
    });

    it('does not coalesce the same session and ref across credential contexts', async () => {
        const firstResponse = deferred<Response>();
        const secondResponse = deferred<Response>();
        const firstCredentials: AuthCredentials = { token: 'first-token', secret: 'first-secret' };
        const secondCredentials: AuthCredentials = { token: 'second-token', secret: 'second-secret' };
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(firstResponse.promise)
            .mockReturnValueOnce(secondResponse.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = requestAttachmentDownloadSource(firstCredentials, 'session-1', 'file-1');
        const second = requestAttachmentDownloadSource(secondCredentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: expect.objectContaining({ Authorization: 'Bearer first-token' }),
        });
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            headers: expect.objectContaining({ Authorization: 'Bearer second-token' }),
        });
        firstResponse.resolve(jsonResponse({ downloadUrl: 'https://api.test/first' }));
        secondResponse.resolve(jsonResponse({ downloadUrl: 'https://api.test/second' }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            { uri: 'https://api.test/first', headers: { Authorization: 'Bearer first-token' } },
            { uri: 'https://api.test/second', headers: { Authorization: 'Bearer second-token' } },
        ]);
    });

    it('coalesces equivalent credentials from separately allocated objects', async () => {
        const response = deferred<Response>();
        const firstCredentials: AuthCredentials = { token: 'equivalent-token', secret: 'first-secret' };
        const secondCredentials: AuthCredentials = { token: 'equivalent-token', secret: 'second-secret' };
        const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = requestAttachmentDownloadSource(firstCredentials, 'session-1', 'file-1');
        const second = requestAttachmentDownloadSource(secondCredentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        response.resolve(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            { uri: 'https://objects.test/file-1', headers: {} },
            { uri: 'https://objects.test/file-1', headers: {} },
        ]);
    });

    it('does not coalesce when a shared credentials object changes token', async () => {
        const firstResponse = deferred<Response>();
        const secondResponse = deferred<Response>();
        const rotatingCredentials: AuthCredentials = { token: 'old-token', secret: 'secret' };
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(firstResponse.promise)
            .mockReturnValueOnce(secondResponse.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = requestAttachmentDownloadSource(rotatingCredentials, 'session-1', 'file-1');
        rotatingCredentials.token = 'new-token';
        const second = requestAttachmentDownloadSource(rotatingCredentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            headers: expect.objectContaining({ Authorization: 'Bearer old-token' }),
        });
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
        });
        firstResponse.resolve(jsonResponse({ downloadUrl: 'https://api.test/first' }));
        secondResponse.resolve(jsonResponse({ downloadUrl: 'https://api.test/second' }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            { uri: 'https://api.test/first', headers: { Authorization: 'Bearer old-token' } },
            { uri: 'https://api.test/second', headers: { Authorization: 'Bearer new-token' } },
        ]);
    });
});
