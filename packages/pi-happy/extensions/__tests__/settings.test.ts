import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSettings } from '../settings';

describe('loadSettings', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('reads machineId from settings.json', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-settings-'));
    tempDirs.push(happyHomeDir);
    const settingsFile = join(happyHomeDir, 'settings.json');

    writeFileSync(settingsFile, JSON.stringify({
      machineId: 'machine-123',
      onboardingCompleted: true,
      schemaVersion: 2,
    }));

    await expect(loadSettings(settingsFile)).resolves.toEqual({ machineId: 'machine-123' });
  });

  it('returns machineId undefined when the file is missing', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-settings-missing-'));
    tempDirs.push(happyHomeDir);

    await expect(loadSettings(join(happyHomeDir, 'settings.json'))).resolves.toEqual({
      machineId: undefined,
    });
  });

  it('returns machineId undefined when settings.json is malformed', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-settings-malformed-'));
    tempDirs.push(happyHomeDir);
    const settingsFile = join(happyHomeDir, 'settings.json');

    writeFileSync(settingsFile, '{broken-json');

    await expect(loadSettings(settingsFile)).resolves.toEqual({ machineId: undefined });
  });

  it('returns machineId undefined when the stored machineId is invalid', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-settings-invalid-'));
    tempDirs.push(happyHomeDir);
    const settingsFile = join(happyHomeDir, 'settings.json');

    writeFileSync(settingsFile, JSON.stringify({ machineId: 123 }));

    await expect(loadSettings(settingsFile)).resolves.toEqual({ machineId: undefined });
  });
});
