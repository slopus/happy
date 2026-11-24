import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.platform === 'win32')('private CLI state on POSIX', () => {
  let scratch: string;
  let dir: string;
  const mode = (path: string) => statSync(path).mode & 0o777;
  beforeEach(() => {
    vi.resetModules();
    scratch = mkdtempSync(join(tmpdir(), 'happy-permissions-'));
    dir = join(scratch, 'custom');
    vi.stubEnv('HAPPY_HOME_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:os');
    rmSync(scratch, { recursive: true, force: true });
  });

  it('creates private homes, credentials, settings and daemon/session state', async () => {
    const { configuration: c } = await import('./configuration');
    const p = await import('./persistence');
    const key = new Uint8Array(32);
    await p.writeCredentialsLegacy({ token: 'test', secret: key });
    expect(mode(c.privateKeyFile)).toBe(0o600);
    await p.clearCredentials();
    await p.writeCredentialsDataKey({ token: 'test', publicKey: key, machineKey: key });
    await p.updateSettings(settings => settings);
    p.writeDaemonState({ pid: 1, httpPort: 1, startTime: '', startedWithCliVersion: '', controlToken: '1'.repeat(64) });
    p.persistSession('test', { encryptionKey: 'test', encryptionVariant: 'legacy', seq: 0, metadataVersion: 0,
      agentStateVersion: 0, metadata: { path: '.', host: 'test', homeDir: dir, happyHomeDir: dir,
        happyLibDir: dir, happyToolsDir: dir }, savedAt: Date.now() });
    expect(mode(dir)).toBe(0o700);
    for (const path of [c.privateKeyFile, c.settingsFile, c.daemonStateFile, c.sessionsFile]) expect(mode(path)).toBe(0o600);
  });

  it.each([false, true])('upgrades existing state without rewriting it (custom home: %s)', async custom => {
    if (!custom) {
      vi.stubEnv('HAPPY_HOME_DIR', '');
      vi.doMock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => scratch }));
      dir = join(scratch, '.happy');
    }
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const files = ['access.key', 'daemon.state.json', 'sessions.json', 'sessions.json.tmp', 'settings.json', 'settings.json.tmp'];
    for (const file of files) {
      writeFileSync(join(dir, file), '{}');
      chmodSync(join(dir, file), 0o644);
    }
    await import('./configuration');
    expect(mode(dir)).toBe(custom ? 0o755 : 0o700);
    for (const file of files) {
      expect(mode(join(dir, file))).toBe(0o600);
      expect(readFileSync(join(dir, file), 'utf8')).toBe('{}');
    }
  });

  it('refuses a shared-writable custom directory without chmodding it', async () => {
    mkdirSync(dir);
    chmodSync(dir, 0o775); // Common for a custom home created under umask 002.
    await expect(import('./configuration')).rejects.toThrow('chmod go-w');
    expect(mode(dir)).toBe(0o775);
    chmodSync(dir, 0o755);
    vi.resetModules();
    await expect(import('./configuration')).resolves.toBeDefined();
  });

  it('identifies a symlinked setting without chmodding its target', async () => {
    mkdirSync(dir);
    const target = join(scratch, 'original');
    writeFileSync(target, '{}');
    chmodSync(target, 0o644);
    const settings = join(dir, 'settings.json');
    symlinkSync(target, settings);
    await expect(import('./configuration')).rejects.toThrow(`Unsafe Happy state file: ${settings}`);
    expect(mode(target)).toBe(0o644);
  });
});