import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({
  configuration: { happyHomeDir: '', privateKeyFile: '', settingsFile: '', daemonStateFile: '', currentCliVersion: '1.2.5' },
  connection: vi.fn(), unlink: vi.fn(), rename: vi.fn(),
}));
vi.mock('@/configuration', () => ({ configuration: mocks.configuration }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/daemon/controlClient', () => ({ getDaemonConnectionStatus: mocks.connection }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: mocks.unlink, rename: mocks.rename };
});

import { getDesktopAuthStatus, handleDesktopAuthManagement, readDesktopResetRequest, resetDesktopAuth } from './desktopAuthManagement';
import { withCliAuthLock } from '@/utils/authLock';
import { updateSettings, writeCredentialsDataKey } from '@/persistence';

const serverUrl = 'https://api.cluster-fluster.com';
const credentials = {
  token: 'synthetic-token-never-exported',
  encryption: { publicKey: Buffer.alloc(32, 1).toString('base64'), machineKey: Buffer.alloc(32, 2).toString('base64') },
};
const originalSettings = { schemaVersion: 1, machineId: 'cli-machine', machineIdConfirmedByServer: true, serverUrl, unrelated: { setting: 1 } };
let directory: string;
let fetchMock: ReturnType<typeof vi.fn>;
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const effects = () => ({ localAuthCleared: false, registrationRemoved: false, daemonStopped: false });
const requestFor = async (removeRegistration = false) => ({
  version: 1 as const, expectedGuard: (await getDesktopAuthStatus()).identityGuard, confirmed: true as const, removeRegistration,
});

beforeEach(async () => {
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  mocks.unlink.mockImplementation(actual.unlink);
  mocks.rename.mockImplementation(actual.rename);
  vi.stubEnv('HAPPY_SERVER_URL', '');
  directory = await mkdtemp(join(tmpdir(), 'happy-cli-auth-management-'));
  Object.assign(mocks.configuration, {
    happyHomeDir: directory, privateKeyFile: join(directory, 'access.key'),
    settingsFile: join(directory, 'settings.json'), daemonStateFile: join(directory, 'daemon.state.json'),
  });
  await writeJson(mocks.configuration.privateKeyFile, credentials);
  await writeJson(mocks.configuration.settingsFile, originalSettings);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  process.exitCode = 0;
  await rm(directory, { recursive: true, force: true });
});

describe('CLI root authentication status', () => {
  it('exports only a fingerprint, exact reset preview, safe daemon state and an opaque identity guard', async () => {
    const before = await readdir(directory);
    const status = await getDesktopAuthStatus();
    expect(status).toMatchObject({
      scope: 'cli-root', cliVersion: '1.2.5', auth: 'v2', machineId: 'cli-machine', serverUrl,
      daemon: { state: 'stopped', connection: null },
      resetPreview: {
        credentialFile: mocks.configuration.privateKeyFile, settingsFile: mocks.configuration.settingsFile,
        settingsFields: ['machineId', 'machineIdConfirmedByServer'], stopsDaemon: true,
      },
    });
    expect(status.accountKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(status.identityGuard).toMatch(/^[a-f0-9]{64}$/);
    const output = JSON.stringify(status);
    for (const secret of [credentials.token, credentials.encryption.publicKey, credentials.encryption.machineKey]) expect(output).not.toContain(secret);
    expect(await readdir(directory)).toEqual(before);
    expect(await readFile(mocks.configuration.privateKeyFile, 'utf8')).toBe(JSON.stringify(credentials));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['missing', 'legacy', 'invalid'] as const)('reports %s without guessing an Agent user or repairing pairing files', async state => {
    if (state === 'missing') await rm(mocks.configuration.privateKeyFile);
    if (state === 'legacy') await writeJson(mocks.configuration.privateKeyFile, { token: credentials.token, secret: Buffer.alloc(32, 3).toString('base64') });
    if (state === 'invalid') await writeFile(mocks.configuration.privateKeyFile, 'synthetic-invalid-secret');
    expect(await getDesktopAuthStatus()).toMatchObject({ auth: state, scope: 'cli-root' });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each([
    ['online', { connected: true }], ['offline', { connected: false }],
    ['identity-mismatch', { machineId: 'another-machine' }], ['identity-mismatch', { serverUrl: 'https://another.example' }],
    ['version-mismatch', { cliVersion: '1.2.4' }], ['unavailable', null],
  ])('reports daemon %s from explicit own identity and connection status', async (expected, override) => {
    await writeJson(mocks.configuration.daemonStateFile, { pid: process.pid, httpPort: 12345 });
    mocks.connection.mockResolvedValue(override === null ? null : { machineId: 'cli-machine', serverUrl, cliVersion: '1.2.5', connected: true, ...override });
    expect((await getDesktopAuthStatus()).daemon.state).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses credential symlinks without printing their contents', async () => {
    const secretPath = join(directory, 'unrelated.key');
    await writeFile(secretPath, 'synthetic-secret-that-must-not-appear');
    await rm(mocks.configuration.privateKeyFile);
    await symlink(secretPath, mocks.configuration.privateKeyFile);
    await expect(getDesktopAuthStatus()).rejects.toMatchObject({ code: 'read_failed' });
    await expect(getDesktopAuthStatus()).rejects.not.toThrow('synthetic-secret');
  });

  it('rejects unsafe server settings instead of exposing URL credentials', async () => {
    await writeJson(mocks.configuration.settingsFile, { ...originalSettings, serverUrl: 'https://user:secret@example.test?token=secret' });
    await expect(getDesktopAuthStatus()).rejects.toMatchObject({ code: 'read_failed' });
  });
});

describe('guarded CLI root reset', () => {
  it('rejects a settings symlink before invoking the permissive legacy settings reader', async () => {
    const request = await requestFor();
    const unrelated = join(directory, 'unrelated-login.key');
    await writeFile(unrelated, 'synthetic-unrelated-secret');
    await rm(mocks.configuration.settingsFile);
    await symlink(unrelated, mocks.configuration.settingsFile);
    const { logger } = await import('@/ui/logger');
    await expect(resetDesktopAuth(request, effects())).rejects.toMatchObject({ code: 'read_failed' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(unrelated, 'utf8')).toBe('synthetic-unrelated-secret');
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(credentials);
  });

  it('local-only reset preserves Agent credentials, recovery keys, logs, session history and unrelated settings', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actual.mkdir(join(directory, 'agent', 'users', 'synthetic-user', 'happy'), { recursive: true });
    const untouched = ['restore.key', 'sessions.json', 'daemon.log', 'agent/users/synthetic-user/happy/access.key'];
    for (const path of untouched) await writeFile(join(directory, path), `keep:${path}`);
    const progress = effects();
    await resetDesktopAuth(await requestFor(), progress);
    expect(progress).toEqual({ localAuthCleared: true, registrationRemoved: false, daemonStopped: true });
    await expect(readFile(mocks.configuration.privateKeyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8'))).toEqual({ schemaVersion: 1, serverUrl, unrelated: { setting: 1 } });
    for (const path of untouched) expect(await readFile(join(directory, path), 'utf8')).toBe(`keep:${path}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['account', 'token', 'server', 'machine', 'confirmation'] as const)('rejects a changed %s before any deletion', async change => {
    const request = await requestFor(true);
    if (change === 'account') await writeJson(mocks.configuration.privateKeyFile, { ...credentials, encryption: { ...credentials.encryption, publicKey: Buffer.alloc(32, 9).toString('base64') } });
    if (change === 'token') await writeJson(mocks.configuration.privateKeyFile, { ...credentials, token: 'new-token' });
    if (change === 'server') await writeJson(mocks.configuration.settingsFile, { ...originalSettings, serverUrl: 'https://changed.example' });
    if (change === 'machine') await writeJson(mocks.configuration.settingsFile, { ...originalSettings, machineId: 'changed-machine' });
    if (change === 'confirmation') request.confirmed = false as unknown as true;
    await expect(resetDesktopAuth(request, effects())).rejects.toMatchObject({ code: change === 'confirmation' ? 'invalid_request' : 'identity_changed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(mocks.configuration.privateKeyFile, 'utf8')).toContain('token');
  });

  it('revalidates a queued reset under the auth lock after a concurrent login', async () => {
    const request = await requestFor();
    let unlock!: () => void;
    let held!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const holder = withCliAuthLock(async () => {
      held();
      await new Promise<void>(resolve => { unlock = resolve; });
      await writeJson(mocks.configuration.privateKeyFile, { ...credentials, token: 'new-login' });
    });
    await ready;
    const reset = resetDesktopAuth(request, effects());
    const outcome = reset.catch(error => error);
    unlock(); await holder;
    expect(await outcome).toMatchObject({ code: 'identity_changed' });
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8')).token).toBe('new-login');
  });

  it('serializes a credential writer behind a guarded reset rather than wiping the new login', async () => {
    const request = await requestFor(true);
    let started!: () => void;
    let finish!: () => void;
    const deleting = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const reset = resetDesktopAuth(request, effects());
    await deleting;
    let written = false;
    const writer = writeCredentialsDataKey({ token: 'new-login', publicKey: Buffer.alloc(32, 8), machineKey: Buffer.alloc(32, 7) }).then(() => { written = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(written).toBe(false);
    finish(); await reset; await writer;
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8')).token).toBe('new-login');
  });

  it('keeps a live settings transaction locked beyond the old ten-second stale threshold', async () => {
    let release!: () => void;
    let held!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const first = updateSettings(async settings => {
      held(); await new Promise<void>(resolve => { release = resolve; });
      return settings;
    });
    await ready;
    await new Promise(resolve => setTimeout(resolve, 11000));
    let entered = false;
    const second = updateSettings(settings => { entered = true; return settings; });
    try {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(entered).toBe(false);
    } finally {
      release(); await first; await second;
    }
  }, 16000);

  it('removes only the guarded current-account registration using its own token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const progress = effects();
    await resetDesktopAuth(await requestFor(true), progress);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${serverUrl}/v1/machines/cli-machine`, expect.objectContaining({
      method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` },
    }));
    expect(progress).toEqual({ localAuthCleared: true, registrationRemoved: true, daemonStopped: true });
  });

  it('finishes an explicitly confirmed reset when the current-account registration is already absent', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const progress = effects();
    await resetDesktopAuth(await requestFor(true), progress);
    expect(progress).toEqual({ localAuthCleared: true, registrationRemoved: true, daemonStopped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires valid own credentials for remote deletion but can clear a confirmed invalid local file', async () => {
    await writeFile(mocks.configuration.privateKeyFile, 'synthetic-invalid-login');
    await expect(resetDesktopAuth(await requestFor(true), effects())).rejects.toMatchObject({ code: 'credential_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    const progress = effects();
    await resetDesktopAuth(await requestFor(), progress);
    expect(progress.localAuthCleared).toBe(true);
  });

  it('preserves authentication and registration fields if the remote deletion fails', async () => {
    fetchMock.mockRejectedValue(new Error(`synthetic transport detail ${credentials.token}`));
    const progress = effects();
    await expect(resetDesktopAuth(await requestFor(true), progress)).rejects.toMatchObject({ code: 'machine_delete_failed' });
    expect(progress).toEqual({ localAuthCleared: false, registrationRemoved: false, daemonStopped: true });
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(credentials);
    expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8'))).toEqual(originalSettings);
  });

  it('reports rejected server authentication distinctly and preserves the local login', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const progress = effects();
    await expect(resetDesktopAuth(await requestFor(true), progress)).rejects.toMatchObject({ code: 'credential_invalid' });
    expect(progress).toEqual({ localAuthCleared: false, registrationRemoved: false, daemonStopped: true });
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(credentials);
  });

  it('reports actual partial progress when remote deletion succeeds but local credential removal fails', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    mocks.unlink.mockImplementation(async path => {
      if (path === mocks.configuration.privateKeyFile) throw new Error('synthetic disk error');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.unlink(path);
    });
    const progress = effects();
    await expect(resetDesktopAuth(await requestFor(true), progress)).rejects.toThrow();
    expect(progress).toEqual({ localAuthCleared: false, registrationRemoved: true, daemonStopped: true });
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(credentials);
  });

  it('reports local credentials already removed if the atomic settings write fails afterward', async () => {
    mocks.rename.mockRejectedValueOnce(new Error('synthetic rename failure'));
    const progress = effects();
    await expect(resetDesktopAuth(await requestFor(), progress)).rejects.toThrow();
    expect(progress.localAuthCleared).toBe(true);
    expect(JSON.parse(await readFile(mocks.configuration.settingsFile, 'utf8'))).toEqual(originalSettings);
  });

  it.each(['other-machine', 'unavailable'])('refuses reset with a live %s daemon instead of signaling its PID', async state => {
    await writeJson(mocks.configuration.daemonStateFile, { pid: process.pid, httpPort: 12345 });
    mocks.connection.mockResolvedValue(state === 'unavailable' ? null : { machineId: 'other-machine', cliVersion: '1.2.5', serverUrl, connected: true });
    const kill = vi.spyOn(process, 'kill');
    await expect(resetDesktopAuth(await requestFor(), effects())).rejects.toMatchObject({ code: 'daemon_unavailable' });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(mocks.configuration.privateKeyFile, 'utf8'))).toEqual(credentials);
  });

  it('waits for a verified own daemon to exit via HTTP before clearing authentication', async () => {
    const fakePid = 987654;
    let alive = true;
    const originalKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== fakePid) return originalKill(pid, signal);
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    await writeJson(mocks.configuration.daemonStateFile, { pid: fakePid, httpPort: 12345 });
    mocks.connection.mockResolvedValue({ machineId: 'cli-machine', cliVersion: '1.2.5', serverUrl, connected: true });
    fetchMock.mockImplementationOnce(async () => { alive = false; return { ok: true, json: async () => ({ status: 'stopping' }) }; });
    const progress = effects();
    await resetDesktopAuth(await requestFor(), progress);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:12345/stop', expect.objectContaining({ method: 'POST' }));
    expect(progress.daemonStopped).toBe(true);
  });
});

describe('closed JSON management protocol', () => {
  it.skipIf(process.platform === 'win32')('rejects a settings FIFO without blocking in configuration startup', async () => {
    await rm(mocks.configuration.settingsFile);
    const fifo = spawnSync('mkfifo', [mocks.configuration.settingsFile], { encoding: 'utf8' });
    expect(fifo.status).toBe(0);
    const response = spawnSync(process.execPath, [
      '--no-warnings', join(process.cwd(), 'dist', 'index.mjs'), 'auth', 'desktop', '--status-json',
    ], { env: { ...process.env, HAPPY_HOME_DIR: directory, HAPPY_SERVER_URL: '', HAPPY_WEBAPP_URL: '' },
      encoding: 'utf8', timeout: 3000 });
    expect(response.status).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({ version: 1, ok: false, error: { code: 'read_failed' } });
  }, 5000);

  it('keeps the built CLI stdout typed under dev/debug/remote-log flags, including reset warnings', async () => {
    // These are synthetic credentials in an isolated home, never the user's host login.
    await writeJson(mocks.configuration.settingsFile, { ...originalSettings, schemaVersion: 999 });
    const run = (operation: string, input?: string) => spawnSync(process.execPath, [
      '--no-warnings', join(process.cwd(), 'dist', 'index.mjs'), 'auth', 'desktop', operation,
    ], {
      env: { ...process.env, HAPPY_HOME_DIR: directory, HAPPY_SERVER_URL: serverUrl,
        HAPPY_VARIANT: 'dev', DEBUG: '1', DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '1' },
      input, encoding: 'utf8', timeout: 10000,
    });
    const statusRun = run('--status-json');
    expect(statusRun.status).toBe(0);
    const status = JSON.parse(statusRun.stdout);
    expect(status).toMatchObject({ version: 1, ok: true, status: { auth: 'v2', scope: 'cli-root' } });
    expect(statusRun.stdout).not.toContain(credentials.token);
    const resetRun = run('--reset-json', JSON.stringify({ version: 1, confirmed: true,
      expectedGuard: status.status.identityGuard, removeRegistration: false }));
    expect(resetRun.status).toBe(0);
    expect(JSON.parse(resetRun.stdout)).toMatchObject({ version: 1, ok: true,
      result: { localAuthCleared: true, registrationRemoved: false, daemonStopped: true } });
    expect(resetRun.stdout).not.toContain(credentials.token);
  }, 20000);

  it('reads only the bounded confirmed reset payload', async () => {
    const request = await requestFor();
    await expect(readDesktopResetRequest(Readable.from([JSON.stringify(request)]))).resolves.toEqual(request);
    await expect(readDesktopResetRequest(Readable.from(['x'.repeat(8193)]))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(readDesktopResetRequest(Readable.from([JSON.stringify({ ...request, userId: 'another-user' })]))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('times out incomplete stdin without any auth mutations', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const outcome = readDesktopResetRequest(input).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ code: 'invalid_request' });
    expect(input.listenerCount('data')).toBe(0);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('prints one versioned status object, with no token, public key or machine key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleDesktopAuthManagement(['--status-json']);
    expect(log).toHaveBeenCalledTimes(1);
    const response = JSON.parse(log.mock.calls[0][0]);
    expect(response).toMatchObject({ version: 1, ok: true, status: { scope: 'cli-root' } });
    expect(log.mock.calls[0][0]).not.toContain(credentials.token);
  });

  it('returns a safe typed error even when credential contents are invalid or sensitive', async () => {
    await writeFile(mocks.configuration.settingsFile, `invalid ${credentials.token}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleDesktopAuthManagement(['--status-json']);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ version: 1, ok: false, error: { code: 'read_failed', localAuthCleared: false } });
    expect(log.mock.calls[0][0]).not.toContain(credentials.token);
    expect(process.exitCode).toBe(1);
  });

  it('reports confirmed remote progress in its JSON error when the following local delete fails', async () => {
    const request = await requestFor(true);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.unlink.mockImplementation(path => path === mocks.configuration.privateKeyFile
      ? Promise.reject(new Error(`disk failure ${credentials.token}`)) : actual.unlink(path));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleDesktopAuthManagement(['--reset-json'], Readable.from([JSON.stringify(request)]));
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      version: 1, ok: false,
      error: { code: 'reset_failed', localAuthCleared: false, registrationRemoved: true, daemonStopped: true },
    });
    expect(log.mock.calls[0][0]).not.toContain(credentials.token);
  });
});