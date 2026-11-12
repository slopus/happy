import { describe, expect, it, vi } from 'vitest';
import { DirectoryCache, getDirectoryCache } from './directoryCache';
describe('directory metadata cache', () => {
    it('deduplicates concurrent requests and retains visible entries during refresh and failure', async () => {
        const cache = new DirectoryCache();
        const entries = [{ name: 'report.md', type: 'file' as const, size: 10, modified: 1 }];
        await cache.load('/task', async () => ({ success: true, entries }), () => true);
        let complete!: (value: { success: boolean; error: string }) => void;
        const loader = vi.fn(() => new Promise<{ success: boolean; error: string }>(resolve => { complete = resolve; }));
        const first = cache.load('/task', loader, () => true);
        const second = cache.load('/task', loader, () => true);
        expect(first).toBe(second);
        expect(cache.getSnapshot()['/task']).toMatchObject({ entries, loading: true });
        await Promise.resolve(); complete({ success: false, error: 'offline' }); await first;
        expect(loader).toHaveBeenCalledTimes(1);
        expect(cache.getSnapshot()['/task']).toMatchObject({ entries, loading: false, error: 'offline' });
    });
    it('isolates account and machine scopes and ignores results from a closed account', async () => {
        const a = getDirectoryCache('account-a:machine-1:/task');
        const b = getDirectoryCache('account-b:machine-1:/task');
        await a.load('/task', async () => ({ success: true, entries: [] }), () => false);
        expect(a.getSnapshot()['/task'].entries).toBeUndefined();
        expect(b.getSnapshot()).toEqual({});
        expect(getDirectoryCache('account-a:machine-1:/task')).toBe(a);
    });
});
