import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
  },
}));

const mockSpawnInTmux = vi.fn(async () => ({ success: true as const }));
const mockExecuteTmuxCommand = vi.fn(async () => ({ stdout: '' }));

vi.mock('@/utils/tmux', () => {
  class TmuxUtilities {
    static DEFAULT_SESSION_NAME = 'happy';
    constructor() {}
    executeTmuxCommand = mockExecuteTmuxCommand;
    spawnInTmux = mockSpawnInTmux;
  }

  return {
    isTmuxAvailable: vi.fn(async () => true),
    TmuxUtilities,
  };
});

vi.mock('@/terminal/tmuxSessionSelector', () => ({
  selectPreferredTmuxSessionName: () => 'picked',
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessInvocation: () => ({ runtime: 'node', argv: ['happy'] }),
}));

describe('startHappyHeadlessInTmux', () => {
  const originalTmuxEnv = process.env.TMUX;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    (Date.now as any).mockRestore?.();
    (console.log as any).mockRestore?.();
    (console.error as any).mockRestore?.();
    process.env = originalEnv;
    process.env.TMUX = originalTmuxEnv;
  });

  it('prints only select-window when already inside tmux', async () => {
    process.env.TMUX = '1';
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    expect(console.log).toHaveBeenCalledWith('✓ Started Happy in tmux');
    expect(console.log).toHaveBeenCalledWith('  Target: picked:happy-123-claude');
    expect(console.log).toHaveBeenCalledWith('  Attach: tmux select-window -t picked:happy-123-claude');
  });

  it('prints attach then select-window when outside tmux', async () => {
    delete process.env.TMUX;
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toEqual([
      '✓ Started Happy in tmux',
      '  Target: happy:happy-123-claude',
      '  Attach: tmux attach -t happy',
      '          tmux select-window -t happy:happy-123-claude',
    ]);
  });
});

