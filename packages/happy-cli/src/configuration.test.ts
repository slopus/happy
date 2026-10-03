import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

async function loadConfiguration(env: Record<string, string | undefined>, settings?: Record<string, unknown>) {
  const happyHomeDir = mkdtempSync(join(tmpdir(), 'happy-config-test-'));
  if (settings) {
    writeFileSync(join(happyHomeDir, 'settings.json'), JSON.stringify(settings));
  }

  process.env = { ...originalEnv, ...env, HAPPY_HOME_DIR: happyHomeDir };
  vi.resetModules();
  const mod = await import('./configuration');

  return {
    configuration: mod.configuration,
    cleanup: () => rmSync(happyHomeDir, { recursive: true, force: true }),
  };
}

describe('configuration URL fallback', () => {
  it('uses HAPPY_SERVER_URL as webappUrl fallback when HAPPY_WEBAPP_URL is not set', async () => {
    const { configuration, cleanup } = await loadConfiguration({
      HAPPY_SERVER_URL: 'http://localhost:5174',
      HAPPY_WEBAPP_URL: undefined,
    });

    expect(configuration.serverUrl).toBe('http://localhost:5174');
    expect(configuration.webappUrl).toBe('http://localhost:5174');
    cleanup();
  });

  it('keeps HAPPY_WEBAPP_URL precedence over serverUrl', async () => {
    const { configuration, cleanup } = await loadConfiguration({
      HAPPY_SERVER_URL: 'http://localhost:5174',
      HAPPY_WEBAPP_URL: 'https://app.example.com',
    });

    expect(configuration.serverUrl).toBe('http://localhost:5174');
    expect(configuration.webappUrl).toBe('https://app.example.com');
    cleanup();
  });

  it('defaults serverUrl and webappUrl to saycode when no env or settings', async () => {
    const { configuration, cleanup } = await loadConfiguration({
      HAPPY_SERVER_URL: undefined,
      HAPPY_WEBAPP_URL: undefined,
    });

    expect(configuration.serverUrl).toBe('https://saycode.ai');
    expect(configuration.webappUrl).toBe('https://saycode.ai');
    cleanup();
  });

  it('applyRelayOverride points serverUrl and webappUrl at the given url (trailing slash stripped)', async () => {
    const { configuration, cleanup } = await loadConfiguration({
      HAPPY_SERVER_URL: undefined,
      HAPPY_WEBAPP_URL: undefined,
    });

    configuration.applyRelayOverride('https://abc.share.zrok.io/');

    expect(configuration.serverUrl).toBe('https://abc.share.zrok.io');
    expect(configuration.webappUrl).toBe('https://abc.share.zrok.io');
    cleanup();
  });
});

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary — the machine control
 * mode is read once per process; anything but an explicit strict is compat.
 */
describe('configuration machine control mode', () => {
  it.each([
    [{ machineControl: 'strict' }, 'strict'],
    [{ machineControl: 'compat' }, 'compat'],
    [{ machineControl: 'STRICT' }, 'compat'],
    [{}, 'compat'],
    [undefined, 'compat'],
  ])('reads %j as %s', async (settings, expected) => {
    const { configuration, cleanup } = await loadConfiguration({}, settings);

    expect(configuration.machineControl).toBe(expected);
    cleanup();
  });

  // HAPPY_MACHINE_CONTROL=strict runs a process strict even from a happy home without
  // settings.json. The variable never lowers strict.
  it.each([
    [{ HAPPY_MACHINE_CONTROL: 'strict' }, undefined, 'strict'],
    [{ HAPPY_MACHINE_CONTROL: 'compat' }, { machineControl: 'strict' }, 'strict'],
    [{ HAPPY_MACHINE_CONTROL: 'anything' }, undefined, 'compat'],
  ])('reads env %j with settings %j as %s', async (env, settings, expected) => {
    const { configuration, cleanup } = await loadConfiguration(env, settings);

    expect(configuration.machineControl).toBe(expected);
    cleanup();
  });
});
