import { describe, expect, it } from 'vitest';
import { SessionCache, type SessionCacheRuntimeStats } from './SessionCache';

describe('SessionCache stats', () => {
  it('tracks cold loads, fresh hits, stale hits, wait-for-refresh calls, and refreshes', async () => {
    const snapshots: SessionCacheRuntimeStats[] = [];
    let loadCount = 0;

    const cache = new SessionCache({
      loader: async () => {
        loadCount++;
        return [{ id: String(loadCount) }];
      },
      staleTTL: 60_000,
      matchFn: () => true,
      onStatsChanged: (stats) => {
        snapshots.push({ ...stats });
      },
    });

    const first = await cache.list({ offset: 0, limit: 10 });
    expect(first.fromCache).toBe(false);
    expect(first.sessions).toEqual([{ id: '1' }]);
    expect(loadCount).toBe(1);

    const second = await cache.list({ offset: 0, limit: 10 });
    expect(second.fromCache).toBe(false);
    expect(second.sessions).toEqual([{ id: '1' }]);
    expect(loadCount).toBe(1);

    cache.invalidate();
    await Promise.resolve();

    const third = await cache.list({ offset: 0, limit: 10 });
    expect(third.fromCache).toBe(true);
    expect(third.sessions).toEqual([{ id: '1' }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadCount).toBe(2);

    cache.invalidate();
    await Promise.resolve();

    const fourth = await cache.list({ offset: 0, limit: 10, waitForRefresh: true });
    expect(fourth.fromCache).toBe(false);
    expect(fourth.sessions).toEqual([{ id: '3' }]);
    expect(loadCount).toBe(3);

    await Promise.resolve();

    const last = snapshots.at(-1)!;
    expect(last.totalRequests).toBe(4);
    expect(last.coldLoadCount).toBe(1);
    expect(last.freshHitCount).toBe(1);
    expect(last.staleHitCount).toBe(1);
    expect(last.waitForRefreshCount).toBe(1);
    expect(last.waitForExistingRefreshHitCount).toBe(0);
    expect(last.refreshCount).toBe(3);
    expect(last.backgroundRefreshCount).toBe(1);
    expect(last.foregroundRefreshCount).toBe(2);
    expect(last.refreshSuccessCount).toBe(3);
    expect(last.refreshErrorCount).toBe(0);
    expect(last.invalidateCount).toBe(2);
    expect(last.lastRefreshMode).toBe('foreground');
    expect(last.lastDecision).toBe('wait-for-refresh');
  });

  it('tracks wait-for-existing-refresh requests separately', async () => {
    const snapshots: SessionCacheRuntimeStats[] = [];
    let resolveLoader!: (value: { id: string }[]) => void;

    const cache = new SessionCache({
      loader: () => new Promise<{ id: string }[]>((resolve) => {
        resolveLoader = resolve;
      }),
      matchFn: () => true,
      onStatsChanged: (stats) => {
        snapshots.push({ ...stats });
      },
    });

    const firstRequest = cache.list({ offset: 0, limit: 10 });
    await Promise.resolve();

    const secondRequest = cache.list({ offset: 0, limit: 10, waitForRefresh: true });
    resolveLoader([{ id: '1' }]);

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first.sessions).toEqual([{ id: '1' }]);
    expect(second.sessions).toEqual([{ id: '1' }]);
    expect(second.fromCache).toBe(false);

    await Promise.resolve();

    const last = snapshots.at(-1)!;
    expect(last.totalRequests).toBe(2);
    expect(last.coldLoadCount).toBe(1);
    expect(last.waitForRefreshCount).toBe(1);
    expect(last.waitForExistingRefreshHitCount).toBe(1);
    expect(last.inFlightJoinCount).toBe(1);
    expect(last.refreshCount).toBe(1);
    expect(last.lastDecision).toBe('wait-for-existing-refresh');
  });

  it('tracks invalidations', async () => {
    const snapshots: SessionCacheRuntimeStats[] = [];
    const cache = new SessionCache({
      loader: async () => [],
      matchFn: () => true,
      onStatsChanged: (stats) => {
        snapshots.push({ ...stats });
      },
    });

    cache.invalidate();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      invalidateCount: 1,
    });
  });
});
