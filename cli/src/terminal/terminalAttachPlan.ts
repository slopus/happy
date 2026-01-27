import type { Metadata } from '@/api/types';
import { parseTmuxSessionIdentifier } from '@/integrations/tmux';

export type TerminalAttachPlan =
  | { type: 'not-attachable'; reason: string }
  | {
      type: 'tmux';
      sessionName: string;
      target: string;
      selectWindowArgs: string[];
      attachSessionArgs: string[];
      tmuxCommandEnv: Record<string, string>;
      /**
       * True when we should clear TMUX/TMUX_PANE from the environment for tmux
       * commands (e.g. isolated tmux server selected via TMUX_TMPDIR).
       */
      shouldUnsetTmuxEnv: boolean;
      /**
       * True when we should run `tmux attach-session ...` after selecting the window.
       * When already inside a shared tmux server, selecting the window is sufficient.
       */
      shouldAttach: boolean;
    };

export function createTerminalAttachPlan(params: {
  terminal: NonNullable<Metadata['terminal']>;
  insideTmux: boolean;
}): TerminalAttachPlan {
  if (params.terminal.mode === 'plain') {
    return {
      type: 'not-attachable',
      reason: 'Session was not started in tmux.',
    };
  }

  const target = params.terminal.tmux?.target;
  if (typeof target !== 'string' || target.trim().length === 0) {
    return {
      type: 'not-attachable',
      reason: 'Session does not include a tmux target.',
    };
  }

  let parsed: ReturnType<typeof parseTmuxSessionIdentifier>;
  try {
    parsed = parseTmuxSessionIdentifier(target);
  } catch {
    return {
      type: 'not-attachable',
      reason: 'Session includes an invalid tmux target.',
    };
  }

  const tmpDir = params.terminal.tmux?.tmpDir;
  const tmuxCommandEnv: Record<string, string> =
    typeof tmpDir === 'string' && tmpDir.trim().length > 0 ? { TMUX_TMPDIR: tmpDir } : {};

  const shouldUnsetTmuxEnv = Object.prototype.hasOwnProperty.call(tmuxCommandEnv, 'TMUX_TMPDIR');

  const shouldAttach = !params.insideTmux || shouldUnsetTmuxEnv;

  return {
    type: 'tmux',
    sessionName: parsed.session,
    target,
    shouldAttach,
    shouldUnsetTmuxEnv,
    tmuxCommandEnv,
    selectWindowArgs: ['select-window', '-t', target],
    attachSessionArgs: ['attach-session', '-t', parsed.session],
  };
}
