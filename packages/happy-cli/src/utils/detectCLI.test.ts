import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAgyBin } from '@/agy/constants';
import { detectCLIAvailability } from './detectCLI';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/person'),
    platform: vi.fn(() => 'darwin'),
  },
}));
vi.mock('@/agy/constants', () => ({ findAgyBin: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedFindAgyBin = vi.mocked(findAgyBin);
const mockedPlatform = vi.mocked(os.platform);

describe('CLI availability detection', () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedFindAgyBin.mockReset();
    mockedFindAgyBin.mockReturnValue(undefined);
    mockedPlatform.mockReturnValue('darwin');
  });

  it('reports Antigravity only when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().agy).toBe(false);

    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability().agy).toBe(true);
  });

  it('reports OpenCode when command-v finds an installation', () => {
    expect(detectCLIAvailability().opencode).toBe(false);

    mockedExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('opencode')) {
        return Buffer.from('/usr/local/bin/opencode');
      }
      throw new Error('not installed');
    });

    expect(detectCLIAvailability().opencode).toBe(true);
  });
});