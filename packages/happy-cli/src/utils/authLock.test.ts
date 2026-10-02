import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({ configuration: { happyHomeDir: '', privateKeyFile: '' } }));
vi.mock('@/configuration', () => ({ configuration: mocks.configuration }));
import { withCliAuthLock } from './authLock';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'happy-cli-auth-lock-'));
  Object.assign(mocks.configuration, { happyHomeDir: directory, privateKeyFile: join(directory, 'access.key') });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('CLI authentication lock', () => {
  it('allows nested auth helpers and releases both lock paths on failure', async () => {
    await expect(withCliAuthLock(() => withCliAuthLock(async () => { throw new Error('synthetic failure'); }))).rejects.toThrow('synthetic failure');
    expect(await readdir(directory)).toEqual([]);
    await expect(withCliAuthLock(async () => 'next operation')).resolves.toBe('next operation');
    expect(await readdir(directory)).toEqual([]);
  });

  it('reclaims only a valid dead owner and never sends a termination signal', async () => {
    await writeFile(`${mocks.configuration.privateKeyFile}.lock`, JSON.stringify({ pid: 987654 }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    await expect(withCliAuthLock(async () => 'acquired')).resolves.toBe('acquired');
    expect(kill).toHaveBeenCalledWith(987654, 0);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it('times out behind a live owner while preserving credentials and its lock', async () => {
    const lock = JSON.stringify({ pid: process.pid });
    await writeFile(`${mocks.configuration.privateKeyFile}.lock`, lock);
    await writeFile(mocks.configuration.privateKeyFile, 'synthetic-existing-login');
    const action = vi.fn();
    const kill = vi.spyOn(process, 'kill');
    await expect(withCliAuthLock(action)).rejects.toThrow('CLI authentication is busy');
    expect(action).not.toHaveBeenCalled();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(await readFile(mocks.configuration.privateKeyFile, 'utf8')).toBe('synthetic-existing-login');
    expect(await readFile(`${mocks.configuration.privateKeyFile}.lock`, 'utf8')).toBe(lock);
    expect(await readdir(directory)).toEqual(['access.key', 'access.key.lock']);
  }, 10000);
});