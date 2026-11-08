import { expect, it, vi } from 'vitest';
import { EventRefreshQueue } from './eventRefreshQueue';
it('serializes two artifacts, coalesces terminal/invalidation bursts and retains a change received during the read', async () => {
    let release!: () => void;
    const first = new Promise<void>(r => { release = r; });
    let source = 1; const observed: number[] = [];
    const read = vi.fn(async (path: string) => { const value = source; if (read.mock.calls.length === 1) await first; observed.push(value); });
    const q = new EventRefreshQueue(read);
    q.enqueue(['md', 'html']); q.enqueue(['md', 'html']);
    await Promise.resolve(); expect(read.mock.calls.map(c => c[0])).toEqual(['md']);
    source = 2; q.enqueue(['md', 'html']); release();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(read.mock.calls.map(c => c[0])).toEqual(['md', 'html', 'md']); expect(observed).toEqual([1, 2, 2]);
    q.dispose(); q.enqueue(['md']); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(3);
});
