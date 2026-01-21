import { posix as pathPosix } from 'node:path';

export type TerminalMode = 'plain' | 'tmux';

export type TerminalTmuxSpawnOptions = {
  /**
   * tmux session to create/select.
   *
   * Note: empty string is allowed for legacy behavior ("current/most recent session"),
   * but should only be used for terminal-initiated flows where "current" is well-defined.
   */
  sessionName?: string;
  /**
   * When true, prefer an isolated tmux server socket (via TMUX_TMPDIR) to avoid
   * interfering with the user's global tmux server.
   */
  isolated?: boolean;
  /**
   * Optional override for TMUX_TMPDIR. When null/undefined and isolated=true, we derive
   * a deterministic directory under happyHomeDir.
   */
  tmpDir?: string | null;
};

export type TerminalSpawnOptions = {
  mode?: TerminalMode;
  tmux?: TerminalTmuxSpawnOptions;
};

export type ResolvedTerminalRequest =
  | { requested: 'plain' }
  | {
    requested: 'tmux';
    tmux: {
      sessionName: string;
      isolated: boolean;
      tmpDir: string | null;
      source: 'typed' | 'legacy';
    };
  }
  | { requested: null };

function normalizeOptionalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveTerminalRequestFromSpawnOptions(params: {
  happyHomeDir: string;
  terminal?: TerminalSpawnOptions;
  environmentVariables?: Record<string, string>;
}): ResolvedTerminalRequest {
  const terminal = params.terminal;
  if (terminal?.mode === 'plain') {
    return { requested: 'plain' };
  }

  if (terminal?.mode === 'tmux') {
    const sessionName = terminal.tmux?.sessionName ?? 'happy';
    const isolated = terminal.tmux?.isolated ?? true;
    const tmpDirOverride = normalizeOptionalPath(terminal.tmux?.tmpDir ?? null);
    const tmpDir = isolated
      ? (tmpDirOverride ?? pathPosix.join(params.happyHomeDir, 'tmux'))
      : tmpDirOverride;

    return {
      requested: 'tmux',
      tmux: {
        sessionName,
        isolated,
        tmpDir,
        source: 'typed',
      },
    };
  }

  const env = params.environmentVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(env, 'TMUX_SESSION_NAME')) {
    const sessionName = env.TMUX_SESSION_NAME;
    const tmpDir = normalizeOptionalPath(env.TMUX_TMPDIR ?? null);
    return {
      requested: 'tmux',
      tmux: {
        sessionName,
        isolated: false,
        tmpDir,
        source: 'legacy',
      },
    };
  }

  return { requested: null };
}

