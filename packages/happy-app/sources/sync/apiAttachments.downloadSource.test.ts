import type { AuthCredentials } from '@/auth/tokenStorage';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { requestAttachmentDownloadSource } from './apiAttachments';
import { invalidateLocalHistorySession } from './localHistoryStore';

const server = vi.hoisted(() => ({ url: 'https://api.test' }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => server.url }));
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
    beforeEach(() => {
        server.url = 'https://api.test';
        invalidateLocalHistorySession('descriptor-tests', 'reset');
    });
    afterEach(() => {
        vi.useRealTimers();
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

    it('times out a stalled descriptor and permits an explicit retry without reusing the hung request', async () => {
        vi.useFakeTimers();
        const late = deferred<Response>();
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(late.promise)
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/retry' }));
        vi.stubGlobal('fetch', fetchMock);
        const first = requestAttachmentDownloadSource(credentials, 'stalled', 'ref').catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await first).toMatchObject({ name: 'AttachmentTransferTimeoutError' });
        expect(fetchMock).toHaveBeenCalledOnce();
        await expect(requestAttachmentDownloadSource(credentials, 'stalled', 'ref')).resolves.toEqual({ uri: 'https://objects.test/retry', headers: {} });
        late.resolve(jsonResponse({ downloadUrl: 'https://objects.test/stale' }));
        await vi.advanceTimersByTimeAsync(0);
        await expect(requestAttachmentDownloadSource(credentials, 'stalled', 'ref')).resolves.toEqual({ uri: 'https://objects.test/retry', headers: {} });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('bypasses a cached descriptor when the media reports a playback error', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/old' }))
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/fresh' }));
        vi.stubGlobal('fetch', fetchMock);
        await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');
        const refreshed = await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1', { forceRefresh: true });
        expect(refreshed.uri).toBe('https://objects.test/fresh');
        expect(fetchMock).toHaveBeenCalledTimes(2);
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

    it('reuses a successful descriptor for sequential consumers within its short TTL', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }))
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/file-1' }));
        vi.stubGlobal('fetch', fetchMock);

        await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');
        await requestAttachmentDownloadSource(credentials, 'session-1', 'file-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
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
        await expect(first).rejects.toThrow('Attachment context expired');
        await expect(second).resolves.toEqual({ uri: 'https://api.test/second', headers: { Authorization: 'Bearer new-token' } });
    });
    it('refreshes after 60 seconds and keeps server contexts separate', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ downloadUrl: 'https://objects.test/ttl' }));
        vi.stubGlobal('fetch', fetchMock);
        await requestAttachmentDownloadSource(credentials, 'ttl', 'ref');
        await requestAttachmentDownloadSource(credentials, 'ttl', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_001);
        await requestAttachmentDownloadSource(credentials, 'ttl', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        server.url = 'https://api.test/alternate';
        await requestAttachmentDownloadSource(credentials, 'ttl', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        server.url = 'https://other.test';
        await requestAttachmentDownloadSource(credentials, 'ttl', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it.each([
        'https://objects.test/signed?X-Amz-Date=20260909T000000Z&X-Amz-Expires=20',
        'https://objects.test/signed?x-oss-date=20260909T000000Z&x-oss-expires=20',
        'https://objects.test/signed?Expires=1788912020',
    ])('stops reusing signed descriptors before actual expiry: %s', async uri => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ downloadUrl: uri }));
        vi.stubGlobal('fetch', fetchMock);
        await requestAttachmentDownloadSource(credentials, 'expiry', 'ref');
        await requestAttachmentDownloadSource(credentials, 'expiry', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(16_000);
        await requestAttachmentDownloadSource(credentials, 'expiry', 'ref');
        await requestAttachmentDownloadSource(credentials, 'expiry', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
        'https://objects.test/signed?X-Amz-Date=20260908T000000Z&X-Amz-Expires=20',
        'https://objects.test/signed?X-Amz-Date=invalid&X-Amz-Expires=20',
    ])('does not cache expired or malformed signature deadlines: %s', async uri => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ downloadUrl: uri }));
        vi.stubGlobal('fetch', fetchMock);
        await requestAttachmentDownloadSource(credentials, 'expired', 'ref');
        await requestAttachmentDownloadSource(credentials, 'expired', 'ref');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('evicts least recently used descriptors after 64 entries', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ downloadUrl: 'https://objects.test/lru' }));
        vi.stubGlobal('fetch', fetchMock);
        for (let i = 0; i < 64; i++) await requestAttachmentDownloadSource(credentials, 'lru', String(i));
        await requestAttachmentDownloadSource(credentials, 'lru', '0');
        await requestAttachmentDownloadSource(credentials, 'lru', '64');
        expect(fetchMock).toHaveBeenCalledTimes(65);
        await requestAttachmentDownloadSource(credentials, 'lru', '0');
        expect(fetchMock).toHaveBeenCalledTimes(65);
        await requestAttachmentDownloadSource(credentials, 'lru', '1');
        expect(fetchMock).toHaveBeenCalledTimes(66);
    });

    it('invalidates successful descriptors and rejects late responses after ownership invalidation', async () => {
        const pending = deferred<Response>();
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/first' }))
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(jsonResponse({ downloadUrl: 'https://objects.test/fresh' }));
        vi.stubGlobal('fetch', fetchMock);
        await requestAttachmentDownloadSource(credentials, 'invalidate', 'ref');
        invalidateLocalHistorySession('descriptor-tests', 'invalidate');
        const stale = requestAttachmentDownloadSource(credentials, 'invalidate', 'ref');
        invalidateLocalHistorySession('descriptor-tests', 'invalidate');
        pending.resolve(jsonResponse({ downloadUrl: 'https://objects.test/stale' }));
        await expect(stale).rejects.toThrow('Attachment context expired');
        await expect(requestAttachmentDownloadSource(credentials, 'invalidate', 'ref'))
            .resolves.toEqual({ uri: 'https://objects.test/fresh', headers: {} });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('checks each coalesced consumer ownership after credential rotation', async () => {
        const response = deferred<Response>();
        const owner = { token: 'shared-token', secret: 'secret' };
        const rotated = { ...owner };
        const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise);
        vi.stubGlobal('fetch', fetchMock);
        const first = requestAttachmentDownloadSource(owner, 'consumer', 'ref');
        const second = requestAttachmentDownloadSource(rotated, 'consumer', 'ref');
        rotated.token = 'new-token';
        response.resolve(jsonResponse({ downloadUrl: 'https://objects.test/shared' }));
        await expect(first).resolves.toEqual({ uri: 'https://objects.test/shared', headers: {} });
        await expect(second).rejects.toThrow('Attachment context expired');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

});
