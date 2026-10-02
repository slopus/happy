import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import { configuration } from '@/configuration';

const context = new AsyncLocalStorage<{ active: boolean }>();

/** Serialize CLI-owned auth mutations across processes; never reclaim a live owner's lock. */
export async function withCliAuthLock<T>(action: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return action();
  await mkdir(configuration.happyHomeDir, { recursive: true, mode: 0o700 });
  const lockPath = `${configuration.privateKeyFile}.lock`;
  const temporaryPath = `${lockPath}.${randomUUID()}`;
  let acquired = false;
  try {
    const owner = await open(temporaryPath, 'wx', 0o600);
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid }));
      await owner.sync();
    } finally {
      await owner.close();
    }
    const deadline = Date.now() + 5000;
    while (!acquired) {
      try {
        await link(temporaryPath, lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Broken/foreign locks are not authority to erase a lock or credentials.
        let file;
        try {
          file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const before = await file.stat();
          if (!before.isFile() || before.size > 256 || (process.getuid && before.uid !== process.getuid())) {
            throw new Error('Invalid authentication lock.');
          }
          const { pid } = JSON.parse(await file.readFile('utf8'));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid authentication lock.');
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              const current = await stat(lockPath);
              if (current.ino === before.ino && current.dev === before.dev) await unlink(lockPath);
            }
          }
        } catch {
          // Wait for a valid owner to release; do not guess ownership.
        } finally {
          await file?.close();
        }
        if (Date.now() >= deadline) throw new Error('CLI authentication is busy. Try again.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const scope = { active: true };
    try {
      return await context.run(scope, action);
    } finally {
      scope.active = false;
    }
  } finally {
    if (acquired) await unlink(lockPath);
    await unlink(temporaryPath).catch(() => {});
  }
}