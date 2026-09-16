import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ index: new Map<string, string>(), vault: new Map<string, any>(), active: 'A', fetch: vi.fn() }));
vi.mock('./accountRuntime', () => ({
    accountIndex: { getString: (key: string) => mocks.index.get(key), set: (key: string, value: string) => mocks.index.set(key, value) },
    getActiveAccountKey: () => mocks.active,
}));
vi.mock('./accounts', () => ({ withAccountRegistryLock: (action: () => Promise<any>) => action() }));
vi.mock('./tokenStorage', () => ({ AccountVault: {
    read: async (key: string) => mocks.vault.get(key), write: async (key: string, value: any) => mocks.vault.set(key, value), remove: async (key: string) => mocks.vault.delete(key),
} }));
vi.mock('./accountNetwork', () => ({ accountCleanupFetch: mocks.fetch }));
beforeEach(() => { mocks.index.clear(); mocks.vault.clear(); mocks.active = 'A'; mocks.fetch.mockReset(); vi.restoreAllMocks(); });
describe('durable push cleanup', () => {
    it('does not starve a due task behind three delayed retries', async () => {
        const api = await import('./accountPushCleanup');
        mocks.active = 'other';
        const jobs = [0, 1, 2, 3].map(i => ({ id: `job${i}`, accountKey: `account${i}`, serverUrl: 'https://example.com', pushToken: `push${i}`, attempts: 1, nextAttempt: i < 3 ? Date.now() + 3600000 : 0 }));
        mocks.index.set('push-cleanup', JSON.stringify(jobs));
        for (const job of jobs) mocks.vault.set(job.id, { token: 'fake-token', secret: '' });
        mocks.fetch.mockResolvedValueOnce({ ok: true });
        await api.retryAccountPushCleanup();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.fetch.mock.calls[0][0]).toContain('push3');
    });
    for (const failure of ['timeout', 'http500']) it(`retries ${failure} after switching and keeps no recovery key`, async () => {
        const api = await import('./accountPushCleanup');
        if (failure === 'timeout') mocks.fetch.mockRejectedValueOnce(new Error('timeout'));
        else mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
        await api.retireAccountPush({ accountKey: 'A', serverUrl: 'https://example.com', pushToken: 'push', token: 'fake-token' });
        expect([...mocks.vault.values()]).toEqual([{ token: 'fake-token', secret: '' }]);
        mocks.active = 'B';
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
        mocks.fetch.mockResolvedValueOnce({ ok: true });
        await api.retryAccountPushCleanup();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mocks.index.get('push-cleanup')!)).toEqual([]);
        expect(mocks.vault.size).toBe(0);
    });
    it('cancels cleanup when returning to the same account', async () => {
        const api = await import('./accountPushCleanup');
        mocks.fetch.mockRejectedValueOnce(new Error('offline'));
        await api.retireAccountPush({ accountKey: 'A', serverUrl: 'https://example.com', pushToken: 'push', token: 'fake-token' });
        await api.retryAccountPushCleanup();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.vault.size).toBe(0);
    });
});
