import { describe, expect, it } from 'vitest';

import { agyQuotaToUsageWindows, agyQuotaToPatch, AGY_HEADLINE_WINDOW_ID } from './agyUsageAdapter';

describe('agyQuotaToUsageWindows', () => {
  it('returns [] for empty / missing input', () => {
    expect(agyQuotaToUsageWindows(undefined)).toEqual([]);
    expect(agyQuotaToUsageWindows(null)).toEqual([]);
    expect(agyQuotaToUsageWindows({})).toEqual([]);
    expect(agyQuotaToUsageWindows({ buckets: [] })).toEqual([]);
  });

  it('skips buckets without a reset or a numeric remainingFraction', () => {
    const windows = agyQuotaToUsageWindows({
      buckets: [
        { modelId: 'no-reset', remainingFraction: 0.5 }, // no resetTime -> unlimited
        { modelId: 'no-fraction', resetTime: '2026-07-24T10:00:00Z' },
        { modelId: 'ok', remainingFraction: 0.5, resetTime: '2026-07-24T10:00:00Z' },
      ],
    });
    // headline + the one limited model
    expect(windows.map((w) => w.id)).toEqual([AGY_HEADLINE_WINDOW_ID, 'agy:ok']);
  });

  it('maps remainingFraction to used% and resetTime to epoch ms', () => {
    const windows = agyQuotaToUsageWindows({
      buckets: [{ modelId: 'gemini-3.1-pro-high', remainingFraction: 0.77, resetTime: '2026-07-24T10:00:00Z' }],
    });
    const model = windows.find((w) => w.id === 'agy:gemini-3.1-pro-high')!;
    expect(model.utilization).toBe(23); // round((1 - 0.77) * 100)
    expect(model.label).toBe('Gemini 3.1 Pro'); // friendly label
    expect(model.resetsAt).toBe(Date.parse('2026-07-24T10:00:00Z'));
    expect(model.status).toBe('allowed');
  });

  it('falls back to the raw modelId when unmapped', () => {
    const windows = agyQuotaToUsageWindows({
      buckets: [{ modelId: 'mystery-model-x', remainingFraction: 0.1, resetTime: '2026-07-24T10:00:00Z' }],
    });
    expect(windows.find((w) => w.id === 'agy:mystery-model-x')!.label).toBe('mystery-model-x');
  });

  it('picks the lowest-remaining bucket as the headline', () => {
    const windows = agyQuotaToUsageWindows({
      buckets: [
        { modelId: 'a', remainingFraction: 0.9, resetTime: '2026-07-24T10:00:00Z' },
        { modelId: 'b', remainingFraction: 0.2, resetTime: '2026-07-24T12:00:00Z' },
        { modelId: 'c', remainingFraction: 0.6, resetTime: '2026-07-24T11:00:00Z' },
      ],
    });
    const headline = windows.find((w) => w.id === AGY_HEADLINE_WINDOW_ID)!;
    expect(headline.utilization).toBe(80); // from b (0.2 remaining)
    expect(headline.resetsAt).toBe(Date.parse('2026-07-24T12:00:00Z')); // b's reset
    expect(windows[0].id).toBe(AGY_HEADLINE_WINDOW_ID); // headline first
  });

  it('marks a fully consumed window as rejected', () => {
    const windows = agyQuotaToUsageWindows({
      buckets: [{ modelId: 'x', remainingFraction: 0, resetTime: '2026-07-24T10:00:00Z' }],
    });
    expect(windows.find((w) => w.id === AGY_HEADLINE_WINDOW_ID)!.status).toBe('rejected');
  });
});

describe('agyQuotaToPatch', () => {
  it('builds a replace snapshot with the given capturedAt', () => {
    const patch = agyQuotaToPatch(
      { buckets: [{ modelId: 'x', remainingFraction: 0.5, resetTime: '2026-07-24T10:00:00Z' }] },
      123456,
    );
    expect(patch.capturedAt).toBe(123456);
    expect(patch.replace).toBe(true);
    expect(patch.windows.map((w) => w.id)).toEqual([AGY_HEADLINE_WINDOW_ID, 'agy:x']);
  });

  it('emits an empty replace patch when nothing is limited (clears a stale chip)', () => {
    const patch = agyQuotaToPatch({ buckets: [] }, 1);
    expect(patch.replace).toBe(true);
    expect(patch.windows).toEqual([]);
  });
});
