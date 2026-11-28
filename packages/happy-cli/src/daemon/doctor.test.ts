import { platform } from 'node:os';
import psList from 'ps-list';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAllHappyProcesses } from './doctor';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn<() => Promise<{ stdout: string, stderr: string }>>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(mockExecFile, { [promisify.custom]: mockExecFile }) };
});
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  platform: vi.fn(),
}));
vi.mock('ps-list', () => ({ default: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('findAllHappyProcesses', () => {
  it('finds Windows daemon and session processes with quoted paths', async () => {
    vi.mocked(platform).mockReturnValue('win32');
    const daemon = String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\José\node_modules\happy-coder\dist\index.mjs" daemon start-sync`;
    const session = String.raw`node.exe "C:\Users\José\node_modules\happy\dist\index.mjs" --started-by daemon`;
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify([
        { ProcessId: 21552, Name: 'node.exe', CommandLine: daemon },
        { ProcessId: 21553, Name: 'node.exe', CommandLine: session },
        { ProcessId: 21554, Name: 'node.exe', CommandLine: String.raw`node.exe C:\work\unrelated\dist\index.mjs` },
        { ProcessId: 21555, Name: 'node.exe', CommandLine: null },
      ]),
      stderr: '',
    });

    expect(await findAllHappyProcesses()).toEqual([
      { pid: 21552, command: daemon, type: 'daemon' },
      { pid: 21553, command: session, type: 'daemon-spawned-session' },
    ]);
    expect(psList).not.toHaveBeenCalled();
  });

  it('reports that the Windows inventory failed when CIM cannot run', async () => {
    vi.mocked(platform).mockReturnValue('win32');
    mockExecFile.mockRejectedValue(new Error('CIM unavailable'));

    await expect(findAllHappyProcesses()).rejects.toThrow('CIM unavailable');
  });
});
