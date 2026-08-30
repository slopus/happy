import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockEnsureDaemonRunning: vi.fn(),
  mockSpawnDaemonSession: vi.fn(),
  mockClaudeFindLastSession: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}));

vi.mock('@/daemon/controlClient', () => ({
  spawnDaemonSession: mocks.mockSpawnDaemonSession,
}));

vi.mock('@/claude/utils/claudeFindLastSession', () => ({
  claudeFindLastSession: mocks.mockClaudeFindLastSession,
}));

import { handleAttachCommand, installSlashCommand, resolveAttachTarget } from './attach';

describe('resolveAttachTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses CODEX_THREAD_ID from the current Codex process', () => {
    const target = resolveAttachTarget([], {
      cwd: '/repo',
      env: { CODEX_THREAD_ID: 'codex-thread-123' },
    });

    expect(target).toEqual({
      agent: 'codex',
      directory: '/repo',
      resumeCodexThreadId: 'codex-thread-123',
      json: false,
    });
  });

  it('uses CLAUDE_SESSION_ID from the current Claude Code process', () => {
    const target = resolveAttachTarget([], {
      cwd: '/repo',
      env: { CLAUDE_SESSION_ID: '93a9705e-bc6a-406d-8dce-8acc014dedbd' },
    });

    expect(target).toEqual({
      agent: 'claude',
      directory: '/repo',
      resumeClaudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
      json: false,
    });
  });

  it('falls back to the latest Claude session in the current directory when requested', () => {
    mocks.mockClaudeFindLastSession.mockReturnValue('93a9705e-bc6a-406d-8dce-8acc014dedbd');

    const target = resolveAttachTarget(['--agent', 'claude', '--path', '/repo'], {
      cwd: '/different',
      env: {},
    });

    expect(mocks.mockClaudeFindLastSession).toHaveBeenCalledWith('/repo');
    expect(target).toEqual({
      agent: 'claude',
      directory: '/repo',
      resumeClaudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
      json: false,
    });
  });

  it('prefers explicit ids over environment inference', () => {
    const target = resolveAttachTarget(
      ['--agent', 'codex', '--codex-thread-id', 'explicit-thread', '--path', '/repo', '--json'],
      {
        cwd: '/different',
        env: { CODEX_THREAD_ID: 'env-thread' },
      },
    );

    expect(target).toEqual({
      agent: 'codex',
      directory: '/repo',
      resumeCodexThreadId: 'explicit-thread',
      json: true,
    });
  });

  it('throws when it cannot find a resumable current session', () => {
    mocks.mockClaudeFindLastSession.mockReturnValue(null);

    expect(() => resolveAttachTarget(['--agent', 'claude'], {
      cwd: '/repo',
      env: {},
    })).toThrow('Could not find a Claude session to attach');
  });
});

describe('handleAttachCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined);
    mocks.mockSpawnDaemonSession.mockResolvedValue({
      success: true,
      sessionId: 'happy-session-123',
    });
  });

  it('spawns a daemon-managed Codex resume session without blocking the caller', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAttachCommand(['--json'], {
      cwd: '/repo',
      env: { CODEX_THREAD_ID: 'codex-thread-123' },
    });

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(mocks.mockSpawnDaemonSession).toHaveBeenCalledWith({
      directory: '/repo',
      agent: 'codex',
      resumeCodexThreadId: 'codex-thread-123',
      environmentVariables: {
        HAPPY_CODEX_APP_SERVER_MODE: 'shared',
        HAPPY_CODEX_APPROVAL_AUTHORITY: 'desktop',
      },
    });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      type: 'success',
      sessionId: 'happy-session-123',
      agent: 'codex',
      directory: '/repo',
    }));
  });

  it('forwards an explicit shared socket and approval authority to the daemon child', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAttachCommand([], {
      cwd: '/repo',
      env: {
        CODEX_THREAD_ID: 'codex-thread-456',
        HAPPY_CODEX_APP_SERVER_SOCKET: '/tmp/codex-shared.sock',
        HAPPY_CODEX_APPROVAL_AUTHORITY: 'paws',
      },
    });

    expect(mocks.mockSpawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: {
        HAPPY_CODEX_APP_SERVER_MODE: 'shared',
        HAPPY_CODEX_APP_SERVER_SOCKET: '/tmp/codex-shared.sock',
        HAPPY_CODEX_APPROVAL_AUTHORITY: 'paws',
      },
    }));
  });
}
);

describe('installSlashCommand', () => {
  it('installs a shared /paws skill for Claude, Codex, and Agents skill loaders', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happy-attach-home-'));

    const installed = await installSlashCommand({ homeDir });

    expect(installed).toEqual([
      join(homeDir, '.claude', 'skills', 'paws', 'SKILL.md'),
      join(homeDir, '.codex', 'skills', 'paws', 'SKILL.md'),
      join(homeDir, '.agents', 'skills', 'paws', 'SKILL.md'),
    ]);
    await expect(readFile(installed[0], 'utf8')).resolves.toContain('happy attach --json');
    await expect(readFile(installed[1], 'utf8')).resolves.toContain('name: paws');
    await expect(readFile(installed[2], 'utf8')).resolves.toContain('Do not run a foreground long-lived Happy session');
  });
});
