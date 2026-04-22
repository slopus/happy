import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../package.json';
import { projectPath } from '@/projectPath';

/**
 * Read the installed CLI version from package.json on disk.
 *
 * We intentionally prefer the runtime package.json over the bundled JSON import:
 * the bundled value can lag behind during upgrades or partial rebuilds, while the
 * daemon/version-check logic needs a single runtime source of truth.
 */
export function getInstalledCliVersion(): string {
  try {
    const packageJsonPath = join(projectPath(), 'package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall back to the bundled version if runtime package.json is unavailable.
  }

  return packageJson.version;
}

/**
 * Snapshot of the CLI version observed when the current process started.
 *
 * This is what the daemon should persist into state so that later heartbeats can
 * detect "the installed version changed underneath me" without mixing sources.
 */
export const startedCliVersion = getInstalledCliVersion();
