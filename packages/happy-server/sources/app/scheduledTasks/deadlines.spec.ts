import { afterEach, expect, it, vi } from 'vitest';
import { createDeadlineScheduler } from './deadlines';

afterEach(() => vi.useRealTimers());
it('fires only at the deadline and replaces stale timers without querying between deadlines', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const scheduler = createDeadlineScheduler();
    const observed: string[] = [];
    scheduler.schedule('task', 3000, async () => { observed.push('stale'); });
    scheduler.schedule('task', 5000, async () => { observed.push('due'); });
    await vi.advanceTimersByTimeAsync(3999);
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed).toEqual(['due']);
    scheduler.stop();
});
it('chunks deadlines beyond Node timer range without firing work early', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const scheduler = createDeadlineScheduler(); let executions = 0;
    scheduler.schedule('long', 3_000_000_000, async () => { executions++; });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(executions).toBe(0);
    await vi.advanceTimersByTimeAsync(852_516_353);
    expect(executions).toBe(1);
    scheduler.stop();
});

it('retains failed work for an event-driven retry without polling', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let attempts = 0;
    const scheduler = createDeadlineScheduler();
    scheduler.schedule('account:task', 1000, async () => { if (++attempts === 1) throw new Error('database temporarily unavailable'); });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempts).toBe(1);
    scheduler.retryFailed('account:');
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    scheduler.retryFailed('account:');
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    scheduler.stop();
});

it('does not restore an obsolete failed deadline after a task has been rescheduled', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let reject!: (error: Error) => void;
    const scheduler = createDeadlineScheduler();
    scheduler.schedule('task', 1000, () => new Promise((_resolve, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(1000);
    let executions = 0;
    scheduler.schedule('task', 5000, async () => { executions++; });
    reject(new Error('old deadline failed'));
    await Promise.resolve();
    scheduler.retryFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(executions).toBe(1);
    scheduler.stop();
});
