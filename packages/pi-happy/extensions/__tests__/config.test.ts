import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_HAPPY_SERVER_URL, loadConfig } from '../config';

describe('loadConfig', () => {
  const originalHappyServerUrl = process.env.HAPPY_SERVER_URL;
  const originalHappyHomeDir = process.env.HAPPY_HOME_DIR;

  afterEach(() => {
    if (originalHappyServerUrl === undefined) {
      delete process.env.HAPPY_SERVER_URL;
    } else {
      process.env.HAPPY_SERVER_URL = originalHappyServerUrl;
    }

    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPY_HOME_DIR;
    } else {
      process.env.HAPPY_HOME_DIR = originalHappyHomeDir;
    }
  });

  it('uses the happy-cli defaults when env vars are not set', () => {
    delete process.env.HAPPY_SERVER_URL;
    delete process.env.HAPPY_HOME_DIR;

    const config = loadConfig();
    const expectedHomeDir = join(homedir(), '.happy');

    expect(config).toEqual({
      serverUrl: DEFAULT_HAPPY_SERVER_URL,
      happyHomeDir: expectedHomeDir,
      privateKeyFile: join(expectedHomeDir, 'access.key'),
      settingsFile: join(expectedHomeDir, 'settings.json'),
      daemonStateFile: join(expectedHomeDir, 'daemon.state.json'),
    });
  });

  it('resolves HAPPY_SERVER_URL and expands a leading ~ in HAPPY_HOME_DIR', () => {
    process.env.HAPPY_SERVER_URL = 'https://staging.cluster-fluster.com';
    process.env.HAPPY_HOME_DIR = '~/Library/Application Support/happy';

    const config = loadConfig();
    const expectedHomeDir = join(homedir(), 'Library/Application Support/happy');

    expect(config.serverUrl).toBe('https://staging.cluster-fluster.com');
    expect(config.happyHomeDir).toBe(expectedHomeDir);
    expect(config.privateKeyFile).toBe(join(expectedHomeDir, 'access.key'));
    expect(config.settingsFile).toBe(join(expectedHomeDir, 'settings.json'));
    expect(config.daemonStateFile).toBe(join(expectedHomeDir, 'daemon.state.json'));
  });

  it('uses HAPPY_HOME_DIR verbatim when it does not start with ~', () => {
    process.env.HAPPY_HOME_DIR = '/tmp/custom-happy-home';

    const config = loadConfig();

    expect(config.happyHomeDir).toBe('/tmp/custom-happy-home');
    expect(config.privateKeyFile).toBe('/tmp/custom-happy-home/access.key');
  });
});
