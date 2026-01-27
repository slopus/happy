import chalk from 'chalk';

import { buildHappyCliSubprocessInvocation } from '@/utils/spawnHappyCLI';
import { isTmuxAvailable, TmuxUtilities } from '@/integrations/tmux';
import { selectPreferredTmuxSessionName } from '@/terminal/tmuxSessionSelector';
import { ensureRemoteStartingModeArgs } from '@/terminal/headlessTmuxArgs';

function removeFlag(argv: string[], flag: string): string[] {
  return argv.filter((arg) => arg !== flag);
}

function inferAgent(argv: string[]): 'claude' | 'codex' | 'gemini' {
  const first = argv[0];
  if (first === 'codex' || first === 'gemini' || first === 'claude') return first;
  return 'claude';
}

function buildWindowEnv(): Record<string, string> {
  const excludedKeys = new Set(['TMUX', 'TMUX_PANE']);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => typeof value === 'string' && !excludedKeys.has(key),
    ),
  ) as Record<string, string>;
}

async function resolveTmuxSessionName(params: {
  requestedSessionName: string;
}): Promise<string> {
  if (params.requestedSessionName !== '') return params.requestedSessionName;

  const tmux = new TmuxUtilities();
  const listResult = await tmux.executeTmuxCommand([
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_attached}\t#{session_last_attached}',
  ]);

  return selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
}

export async function startHappyHeadlessInTmux(argv: string[]): Promise<void> {
  const argsWithoutTmux = removeFlag(argv, '--tmux');
  const agent = inferAgent(argsWithoutTmux);
  const childArgs = agent === 'claude' ? ensureRemoteStartingModeArgs(argsWithoutTmux) : argsWithoutTmux;

  if (!(await isTmuxAvailable())) {
    console.error(chalk.red('Error:'), 'tmux is not available on this machine.');
    process.exit(1);
  }

  const insideTmux = Boolean(process.env.TMUX);
  const requestedSessionName = insideTmux ? '' : TmuxUtilities.DEFAULT_SESSION_NAME;
  const resolvedSessionName = await resolveTmuxSessionName({ requestedSessionName });

  const windowName = `happy-${Date.now()}-${agent}`;
  const tmuxTarget = `${resolvedSessionName}:${windowName}`;

  const terminalRuntimeArgs = [
    '--happy-terminal-mode',
    'tmux',
    '--happy-terminal-requested',
    'tmux',
    '--happy-tmux-target',
    tmuxTarget,
  ];

  const inv = buildHappyCliSubprocessInvocation([...childArgs, ...terminalRuntimeArgs]);
  const commandTokens = [inv.runtime, ...inv.argv];

  const tmux = new TmuxUtilities(resolvedSessionName);
  const result = await tmux.spawnInTmux(
    commandTokens,
    {
      sessionName: resolvedSessionName,
      windowName,
      cwd: process.cwd(),
    },
    buildWindowEnv(),
  );

  if (!result.success) {
    console.error(chalk.red('Error:'), `Failed to start in tmux: ${result.error ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(chalk.green('✓ Started Happy in tmux'));
  console.log(`  Target: ${tmuxTarget}`);
  if (insideTmux) {
    console.log(`  Attach: tmux select-window -t ${tmuxTarget}`);
  } else {
    console.log(`  Attach: tmux attach -t ${resolvedSessionName}`);
    console.log(`          tmux select-window -t ${tmuxTarget}`);
  }
}
