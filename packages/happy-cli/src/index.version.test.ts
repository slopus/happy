/**
 * Bin-level regression coverage for version flags exiting before CLI startup.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import packageJson from '../package.json';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('CLI version command', (): void => {
  it.each(['--version', '-v'] as const)('prints only the Paws CLI version for %s and exits without starting authentication', async (versionFlag): Promise<void> => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'paws-version-command-'));
    try {
      const result = await execFileAsync(join(packageRoot, 'bin', 'happy.mjs'), [versionFlag], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HAPPY_HOME_DIR: happyHomeDir,
          HAPPY_SKIP_UPDATE_CHECK: '1',
        },
        timeout: 30_000,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(`happy version: ${packageJson.version}\n`);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  }, 35_000);
});
