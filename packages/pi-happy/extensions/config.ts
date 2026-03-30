import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PiHappyConfig } from './types';

export const DEFAULT_HAPPY_SERVER_URL = 'https://api.cluster-fluster.com';

function resolveHappyHomeDir(): string {
  if (process.env.HAPPY_HOME_DIR) {
    return process.env.HAPPY_HOME_DIR.replace(/^~/, homedir());
  }

  return join(homedir(), '.happy');
}

export function loadConfig(): PiHappyConfig {
  const happyHomeDir = resolveHappyHomeDir();

  return {
    serverUrl: process.env.HAPPY_SERVER_URL || DEFAULT_HAPPY_SERVER_URL,
    happyHomeDir,
    privateKeyFile: join(happyHomeDir, 'access.key'),
    settingsFile: join(happyHomeDir, 'settings.json'),
    daemonStateFile: join(happyHomeDir, 'daemon.state.json'),
  };
}
