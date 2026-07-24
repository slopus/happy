import { describe, expect, it, vi } from 'vitest';

import { createAgyUsageCollector } from './agyUsageCollector';
import type { AgyQuotaResponse } from './agyUsageAdapter';

const QUOTA: AgyQuotaResponse = {
  buckets: [{ modelId: 'gemini-3.1-pro-high', remainingFraction: 0.5, resetTime: '2026-07-24T10:00:00Z' }],
};

/** Drain the promise chain the collector schedules its pulls on. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeCollector(over: { now?: () => number, minIntervalMs?: number } = {}) {
  const fetchQuota = vi.fn(async () => QUOTA);
  const onPatch = vi.fn();
  const collector = createAgyUsageCollector({
    onPatch,
    client: { fetchQuota },
    now: over.now ?? (() => 1_000_000),
    minIntervalMs: over.minIntervalMs,
  });
  return { collector, fetchQuota, onPatch };
}

describe('createAgyUsageCollector', () => {
  it('emits a replace patch built from the fetched quota', async () => {
    const { collector, onPatch } = makeCollector();
    collector.refresh();
    await settle();

    expect(onPatch).toHaveBeenCalledOnce();
    const patch = onPatch.mock.calls[0][0];
    expect(patch.replace).toBe(true);
    expect(patch.capturedAt).toBe(1_000_000);
    expect(patch.windows.find((w: { id: string }) => w.id === 'agy')?.utilization).toBe(50);
  });

  it('collapses refreshes inside the minimum interval into one pull', async () => {
    const { collector, fetchQuota } = makeCollector();
    collector.refresh();
    collector.refresh();
    collector.refresh();
    await settle();

    expect(fetchQuota).toHaveBeenCalledOnce();
  });

  it('pulls again once the minimum interval has passed', async () => {
    let clock = 1_000_000;
    const { collector, fetchQuota } = makeCollector({ now: () => clock, minIntervalMs: 60_000 });
    collector.refresh();
    await settle();
    clock += 60_000;
    collector.refresh();
    await settle();

    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });

  it('swallows fetch failures instead of rejecting', async () => {
    const onPatch = vi.fn();
    const log = vi.fn();
    const collector = createAgyUsageCollector({
      onPatch,
      log,
      client: { fetchQuota: async () => { throw new Error('boom'); } },
    });
    collector.refresh();
    await settle();

    expect(onPatch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('stops emitting after stop()', async () => {
    const { collector, onPatch } = makeCollector();
    collector.stop();
    collector.refresh();
    await settle();

    expect(onPatch).not.toHaveBeenCalled();
  });
});
