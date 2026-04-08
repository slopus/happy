import { describe, expect, it } from 'vitest';

import { InvalidateSync } from './invalidate-sync';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('InvalidateSync', () => {
  it('coalesces repeated invalidations into a follow-up run', async () => {
    let runCount = 0;
    let releaseFirstRun: () => void = () => {};

    const sync = new InvalidateSync(async () => {
      runCount += 1;
      if (runCount === 1) {
        await new Promise<void>(resolve => {
          releaseFirstRun = resolve;
        });
      }
    });

    sync.invalidate();
    sync.invalidate();
    await wait(20);

    expect(runCount).toBe(1);

    releaseFirstRun();
    await wait(20);

    expect(runCount).toBe(2);
  });

  it('resolves invalidateAndAwait when work finishes', async () => {
    let runCount = 0;
    const sync = new InvalidateSync(async () => {
      runCount += 1;
      await wait(10);
    });

    await sync.invalidateAndAwait();

    expect(runCount).toBe(1);
  });

  it('stops accepting new invalidations after stop()', async () => {
    let runCount = 0;
    const sync = new InvalidateSync(async () => {
      runCount += 1;
      await wait(10);
    });

    sync.stop();
    sync.invalidate();
    await wait(20);

    expect(runCount).toBe(0);
  });
});
