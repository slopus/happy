import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockProjectPath: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: mocks.mockReadFileSync,
  };
});

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

describe('cliVersion', () => {
  it('prefers the installed package.json version on disk', async () => {
    mocks.mockProjectPath.mockReturnValue('/tmp/happy');
    mocks.mockReadFileSync.mockReturnValue(JSON.stringify({ version: '9.9.9' }));

    const { getInstalledCliVersion } = await import('./cliVersion');

    expect(getInstalledCliVersion()).toBe('9.9.9');
    expect(mocks.mockReadFileSync).toHaveBeenCalledWith('/tmp/happy/package.json', 'utf-8');
  });

  it('falls back to the bundled package version when disk lookup fails', async () => {
    mocks.mockProjectPath.mockReturnValue('/tmp/happy');
    mocks.mockReadFileSync.mockImplementation(() => {
      throw new Error('boom');
    });

    const { getInstalledCliVersion } = await import('./cliVersion');

    expect(getInstalledCliVersion()).toBe('1.1.7');
  });
});
