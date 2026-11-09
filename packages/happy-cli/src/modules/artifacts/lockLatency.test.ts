import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

const state = vi.hoisted(() => ({
  watcherStarted: undefined as undefined | (() => void),
  onClose: undefined as undefined | (() => void),
  unlinkFailure: '',
  closeDelay: 0,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (path === state.unlinkFailure) throw Object.assign(new Error('Cannot release lock'), { code: 'EACCES' });
      return actual.unlink(path);
    },
  };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        state.onClose?.();
        if (state.closeDelay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.closeDelay);
        close();
      };
      state.watcherStarted?.();
      return watcher;
    },
  };
});

import { processOwner, withMachineLock } from './files';

let directory = '';
afterEach(async () => {
  state.watcherStarted = undefined;
  state.onClose = undefined;
  state.unlinkFailure = '';
  state.closeDelay = 0;
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('releases the machine lock before a slow watcher cleanup', async () => {
  state.closeDelay = 700;
  directory = await mkdtemp(join(tmpdir(), 'paws-slow-watch-'));
  let release!: () => void;
  let started!: () => void;
  const acquired = new Promise<void>(resolve => { started = resolve; });
  const holder = withMachineLock(directory, async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await acquired;
  const watching = new Promise<void>(resolve => { state.watcherStarted = resolve; });
  let lockPresentDuringClose: boolean | undefined;
  state.onClose = () => { lockPresentDuringClose = existsSync(join(directory, 'machine.lock')); };
  const waiter = withMachineLock(directory, async () => 'completed', { waitTimeoutMs: 5000 });
  try {
    await watching;
    release();
    await holder;
    expect(await waiter).toBe('completed');
    expect(lockPresentDuringClose).toBe(false);
  } finally {
    release();
    await Promise.allSettled([holder, waiter]);
  }
});

it('closes the watcher and removes its candidate when lock release fails', async () => {
  directory = await mkdtemp(join(tmpdir(), 'paws-failed-unlock-'));
  const lock = join(directory, 'machine.lock');
  await writeFile(lock, JSON.stringify(await processOwner()));
  let closed = 0;
  let executed = false;
  state.watcherStarted = () => { unlinkSync(lock); };
  state.onClose = () => { closed++; };
  state.unlinkFailure = lock;

  await expect(withMachineLock(directory, async () => {
    executed = true;
  }, { waitTimeoutMs: 5000 })).rejects.toMatchObject({ code: 'EACCES' });

  expect(executed).toBe(true);
  expect(closed).toBe(1);
  expect(await readdir(directory)).toEqual(['machine.lock']);
});
