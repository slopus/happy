import { describe, expect, it } from 'vitest';

import { ConnectionState, type PiHappyConfig } from '../types';

describe('pi-happy shared types', () => {
  it('exposes stable connection state values', () => {
    expect(ConnectionState).toEqual({
      Disconnected: 'disconnected',
      Connecting: 'connecting',
      Connected: 'connected',
      Offline: 'offline',
    });
  });

  it('supports the config shape used by the extension package', () => {
    const config: PiHappyConfig = {
      serverUrl: 'https://api.cluster-fluster.com',
      happyHomeDir: '/Users/steve/.happy',
      privateKeyFile: '/Users/steve/.happy/access.key',
      settingsFile: '/Users/steve/.happy/settings.json',
      daemonStateFile: '/Users/steve/.happy/daemon.state.json',
    };

    expect(config.serverUrl).toBe('https://api.cluster-fluster.com');
    expect(config.happyHomeDir).toContain('.happy');
  });
});
