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
});
