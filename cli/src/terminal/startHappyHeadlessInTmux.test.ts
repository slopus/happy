import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
  },
}));

const mockSpawnInTmux = vi.fn(
  async (_args: string[], _options: any, _env?: Record<string, string>) => ({ success: true as const }),
);
const mockExecuteTmuxCommand = vi.fn(async () => ({ stdout: '' }));

vi.mock('@/integrations/tmux', () => {
  class TmuxUtilities {
    static DEFAULT_SESSION_NAME = 'happy';
    constructor() {}
    executeTmuxCommand = mockExecuteTmuxCommand;
    spawnInTmux = mockSpawnInTmux;
  }

  return {
    isTmuxAvailable: vi.fn(async () => true),
    selectPreferredTmuxSessionName: () => 'picked',
    TmuxUtilities,
  };
});

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessInvocation: () => ({ runtime: 'node', argv: ['happy'] }),
}));

describe('startHappyHeadlessInTmux', () => {
  const originalTmuxEnv = process.env.TMUX;

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
    if (originalTmuxEnv === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmuxEnv;
    }
  });

  it('prints only select-window when already inside tmux', async () => {
    process.env.TMUX = '1';
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const lines = (console.log as any).mock.calls.map((c: any[]) => String(c[0] ?? ''));
    expect(lines.some((l: string) => l.includes('Started Happy in tmux'))).toBe(true);
    expect(lines.some((l: string) => l.includes('tmux select-window -t') && l.includes('picked:happy-123-claude'))).toBe(true);
    expect(lines.some((l: string) => l.includes('tmux attach -t'))).toBe(false);
  });

  it('prints attach then select-window when outside tmux', async () => {
    delete process.env.TMUX;
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const lines = (console.log as any).mock.calls.map((c: any[]) => String(c[0] ?? ''));
    const attachIdx = lines.findIndex((l: string) => l.includes('tmux attach -t') && l.includes('happy'));
    const selectIdx = lines.findIndex((l: string) => l.includes('tmux select-window -t') && l.includes('happy:happy-123-claude'));
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeLessThan(selectIdx);
  });

  it('does not pass TMUX variables through to the tmux window environment', async () => {
    process.env.TMUX = '1';
    process.env.TMUX_PANE = '%1';
    process.env.HAPPY_TEST_FOO = 'bar';
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const env = mockSpawnInTmux.mock.calls[0]?.[2] as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env?.TMUX).toBeUndefined();
    expect(env?.TMUX_PANE).toBeUndefined();
    expect(env?.HAPPY_TEST_FOO).toBe('bar');

    delete process.env.TMUX_PANE;
    delete process.env.HAPPY_TEST_FOO;
  });
});
