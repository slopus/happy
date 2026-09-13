import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  configuration: { happyHomeDir: '', privateKeyFile: '', settingsFile: '', serverUrl: 'https://api.cluster-fluster.com', currentCliVersion: 'test' },
  link: vi.fn(),
  spawn: vi.fn(),
  status: vi.fn(),
  stopDaemon: vi.fn(),
}));
vi.mock('@/configuration', () => ({ configuration: mocks.configuration }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  mocks.link.mockImplementation(actual.link);
  return { ...actual, link: mocks.link };
});
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));
vi.mock('@/daemon/controlClient', () => ({
  getDaemonConnectionStatus: mocks.status,
  stopDaemon: mocks.stopDaemon,
  checkIfDaemonRunningAndCleanupStaleState: vi.fn(),
}));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn(() => { throw new Error('Must not prompt'); }) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('node:readline', () => ({ createInterface: () => ({ question: (_: string, answer: (value: string) => void) => answer('yes'), close: vi.fn() }) }));

import { handleDesktopAuth, importDesktopCredentials } from './desktopAuth';

const serverUrl = 'https://api.cluster-fluster.com';
const source = {
  token: 'synthetic-desktop-token',
  encryption: { publicKey: Buffer.alloc(32, 1).toString('base64'), machineKey: Buffer.alloc(32, 2).toString('base64') },
};
let directory: string;
let agentHome: string;
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));

beforeEach(async () => {
  vi.clearAllMocks();
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  mocks.link.mockImplementation(actualFs.link);
  vi.stubEnv('HAPPY_SERVER_URL', '');
  vi.stubEnv('HAPPY_AGENT_HAPPY_SERVER_URL', '');
  directory = await mkdtemp(join(tmpdir(), 'happy-desktop-link-test-'));
  agentHome = join(directory, 'agent', 'happy');
  Object.assign(mocks.configuration, {
    happyHomeDir: directory,
    privateKeyFile: join(directory, 'access.key'),
    settingsFile: join(directory, 'settings.json'),
    serverUrl,
  });
  await mkdir(agentHome, { recursive: true });
  await writeJson(join(agentHome, 'access.key'), source);
  await writeJson(join(agentHome, 'settings.json'), { serverUrl });
  mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('desktop credential reuse', () => {
  it('probes exactly the capability without reading pairing or starting a daemon', async () => {
    await rm(join(agentHome, 'access.key'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleDesktopAuth(['--check']);
    expect(output).toHaveBeenCalledExactlyOnceWith('happy-desktop-link-v1');
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(stat(mocks.configuration.privateKeyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes complete V2 credentials with owner-only permissions and a separate stable machine ID', async () => {
    await writeJson(join(agentHome, 'machine.json'), { machineId: 'agent-machine' });
    const first = await importDesktopCredentials();
    expect(first.serverUrl).toBe(serverUrl);
    expect(first.machineId).not.toBe('agent-machine');
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(source);
    expect((await stat(mocks.configuration.privateKeyFile)).mode & 0o777).toBe(0o600);
    expect(await importDesktopCredentials()).toEqual(first);
    expect((await readdir(directory)).filter(name => name.startsWith('.desktop-link-'))).toEqual([]);
  });

  it('preserves an existing same-account token, machine key, ID and unrelated settings', async () => {
    const existing = { ...source, token: 'existing-token', encryption: { ...source.encryption, machineKey: Buffer.alloc(32, 3).toString('base64') } };
    const bytes = JSON.stringify(existing, null, 4);
    await writeFile(mocks.configuration.privateKeyFile, bytes);
    await writeJson(mocks.configuration.settingsFile, { machineId: 'cli-machine', chromeMode: true });
    await rm(join(agentHome, 'settings.json'));
    expect(await importDesktopCredentials()).toEqual({ serverUrl, machineId: 'cli-machine' });
    expect(await readFile(mocks.configuration.privateKeyFile, 'utf8')).toBe(bytes);
    expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8'))).toMatchObject({ machineId: 'cli-machine', chromeMode: true });
  });

  it.each(['account', 'server'])('refuses a different %s without changing existing files', async mismatch => {
    const existing = mismatch === 'account'
      ? { ...source, encryption: { ...source.encryption, publicKey: Buffer.alloc(32, 9).toString('base64') } }
      : source;
    const settings = { machineId: 'cli-machine', serverUrl: mismatch === 'server' ? 'https://different.example' : serverUrl };
    await writeJson(mocks.configuration.privateKeyFile, existing);
    await writeJson(mocks.configuration.settingsFile, settings);
    await expect(importDesktopCredentials()).rejects.toThrow(mismatch === 'account' ? 'different accounts' : 'different servers');
    expect(await readFile(mocks.configuration.privateKeyFile, 'utf8')).toBe(JSON.stringify(existing));
    expect(await readFile(mocks.configuration.settingsFile, 'utf8')).toBe(JSON.stringify(settings));
  });

  it('does not leave an empty target when publication fails', async () => {
    mocks.link.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(importDesktopCredentials()).rejects.toThrow('disk full');
    await expect(stat(mocks.configuration.privateKeyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter(name => name.startsWith('.desktop-link-'))).toEqual([]);
    await expect(importDesktopCredentials()).resolves.toMatchObject({ serverUrl });
  });

  it('does not overwrite a same-account login published concurrently', async () => {
    const concurrent = { ...source, token: 'concurrent-token', encryption: { ...source.encryption, machineKey: Buffer.alloc(32, 4).toString('base64') } };
    mocks.link.mockImplementationOnce(async () => {
      await writeJson(mocks.configuration.privateKeyFile, concurrent);
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    });
    await importDesktopCredentials();
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(concurrent);
  });

  it('honors native/server environment overrides before stored server settings', async () => {
    vi.stubEnv('HAPPY_SERVER_URL', 'https://override.example/');
    vi.stubEnv('HAPPY_AGENT_HAPPY_SERVER_URL', 'https://override.example');
    await writeJson(mocks.configuration.privateKeyFile, source);
    await writeJson(mocks.configuration.settingsFile, { machineId: 'cli-machine', serverUrl });
    expect(await importDesktopCredentials()).toEqual({ serverUrl: 'https://override.example', machineId: 'cli-machine' });
  });

  it.each([
    { secret: Buffer.alloc(32).toString('base64'), token: 'legacy' },
    { ...source, encryption: { ...source.encryption, machineKey: 'invalid' } },
    { ...source, token: 'x'.repeat(70 * 1024) },
  ])('rejects legacy, malformed and oversized credentials without creating a CLI key', async invalid => {
    await writeJson(join(agentHome, 'access.key'), invalid);
    await expect(importDesktopCredentials()).rejects.toThrow();
    await expect(stat(mocks.configuration.privateKeyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects credential symlinks and never prints invalid JSON contents', async () => {
    const sensitive = 'synthetic-token-that-must-not-appear-in-errors';
    await writeFile(join(agentHome, 'access.key'), sensitive);
    await expect(importDesktopCredentials()).rejects.not.toThrow(sensitive);
    await symlink(join(agentHome, 'access.key'), mocks.configuration.privateKeyFile);
    await writeJson(join(agentHome, 'access.key'), source);
    await expect(importDesktopCredentials()).rejects.toThrow('Cannot read');
  });
});

describe('desktop daemon readiness', () => {
  async function startWithFakeClock() {
    await writeJson(mocks.configuration.settingsFile, { machineId: 'cli-machine', serverUrl });
    vi.useFakeTimers();
    let onSpawn!: () => void;
    const spawned = new Promise<void>(resolve => { onSpawn = resolve; });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockImplementationOnce(() => { onSpawn(); return child; });
    const result = handleDesktopAuth([]);
    // Attach a rejection observer immediately, before advancing timers.
    const outcome = result.then(() => null, error => error as Error);
    await spawned;
    return { outcome, child };
  }

  const ready = { machineId: 'cli-machine', cliVersion: 'test', serverUrl, connected: true };

  it('waits past stale version, wrong machine/server and unregistered RPCs', async () => {
    mocks.status
      .mockResolvedValueOnce({ ...ready, cliVersion: 'old' })
      .mockResolvedValueOnce({ ...ready, machineId: 'other' })
      .mockResolvedValueOnce({ ...ready, serverUrl: 'https://other.example' })
      .mockResolvedValueOnce({ ...ready, connected: false })
      .mockResolvedValue(ready);
    vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'stale-session');
    const { outcome } = await startWithFakeClock();
    await vi.advanceTimersByTimeAsync(1250);
    expect(await outcome).toBeNull();
    expect(mocks.status).toHaveBeenCalledTimes(5);
    expect(mocks.spawn).toHaveBeenCalledWith(['daemon', 'start-sync'], expect.objectContaining({
      detached: true,
      env: expect.objectContaining({ HAPPY_SERVER_URL: serverUrl, HAPPY_BOOT_AGENT: '0', HAPPY_EXPERIMENTAL: '0' }),
    }));
    expect(mocks.spawn.mock.calls[0][1].env).not.toHaveProperty('HAPPY_RECONNECT_SESSION_ID');
  });

  it('fails within the readiness deadline and keeps the pairing', async () => {
    mocks.status.mockResolvedValue(null);
    const { outcome } = await startWithFakeClock();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ message: expect.stringContaining('spawn and resume are not online') });
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(source);
  });

  it('reports a child startup failure rather than claiming the local listener is ready', async () => {
    mocks.status.mockResolvedValue(null);
    const { outcome, child } = await startWithFakeClock();
    child.emit('error', new Error('synthetic spawn failure'));
    await vi.advanceTimersByTimeAsync(250);
    expect(await outcome).toMatchObject({ message: expect.stringContaining('could not start') });
  });
});

it('CLI logout removes only CLI authentication and machine ID, preserving Agent and history', async () => {
  const { handleAuthCommand } = await import('./auth');
  await writeJson(mocks.configuration.privateKeyFile, source);
  await writeJson(mocks.configuration.settingsFile, { machineId: 'cli-machine', chromeMode: true });
  await writeFile(join(directory, 'sessions.json'), 'synthetic-session-history');
  await writeFile(join(directory, 'agent.key'), 'synthetic-remote-controller-key');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await handleAuthCommand(['logout']);
  await expect(stat(mocks.configuration.privateKeyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8'))).toMatchObject({ chromeMode: true });
  expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8')).machineId).toBeUndefined();
  expect(JSON.parse(await readFile(join(agentHome, 'access.key'), 'utf8'))).toEqual(source);
  expect(await readFile(join(directory, 'sessions.json'), 'utf8')).toBe('synthetic-session-history');
  expect(await readFile(join(directory, 'agent.key'), 'utf8')).toBe('synthetic-remote-controller-key');
});