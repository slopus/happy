import { afterEach, expect, it, vi } from 'vitest';
import { appAuthorizationRequest, isAppGrantActive } from './apiAppDelegation';
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('supports the native AbortController without AbortSignal static methods and cleans its timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AbortSignal', {});
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ grants: [] }) }));
    vi.stubGlobal('fetch', fetcher);
    expect(await appAuthorizationRequest('owner', '')).toEqual({ grants: [] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it('forwards cancellation when a panel closes and bounds an unresponsive request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const cancellation = new AbortController();
    const request = appAuthorizationRequest('owner', '', undefined, 'GET', cancellation.signal);
    const cancelled = expect(request).rejects.toThrow('aborted');
    cancellation.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    const timed = expect(appAuthorizationRequest('owner', '')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(15_000);
    await timed;
    expect(vi.getTimerCount()).toBe(0);
});

it('treats explicit permanent approved grants as active but never revoked or pending ones', () => {
    const grant = { id: 'grant', appId: 'app', machineId: 'machine', state: 'redeemed', expiresAt: null, createdAt: '' };
    expect(isAppGrantActive(grant)).toBe(true);
    expect(isAppGrantActive({ ...grant, state: 'revoked' })).toBe(false);
    expect(isAppGrantActive({ ...grant, state: 'pending' })).toBe(false);
    expect(isAppGrantActive({ ...grant, expiresAt: new Date(0).toISOString() })).toBe(false);
});
