import { describe, expect, it } from 'vitest';

import { AsyncLock } from './async-lock';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('AsyncLock', () => {
  it('serializes concurrent work', async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    await Promise.all([
      lock.inLock(async () => {
        events.push('first:start');
        await wait(20);
        events.push('first:end');
      }),
      lock.inLock(async () => {
        events.push('second:start');
        await wait(5);
        events.push('second:end');
      }),
    ]);

    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('releases the lock after failures', async () => {
    const lock = new AsyncLock();

    await expect(lock.inLock(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(lock.inLock(async () => 'ok')).resolves.toBe('ok');
  });
});
