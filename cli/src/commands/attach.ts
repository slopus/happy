import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { configuration } from '@/configuration';
import { readTerminalAttachmentInfo } from '@/terminal/terminalAttachmentInfo';
import { createTerminalAttachPlan } from '@/terminal/terminalAttachPlan';
import { isTmuxAvailable, normalizeExitCode } from '@/integrations/tmux';

function spawnTmux(params: {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | 'ignore';
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('tmux', params.args, {
      stdio: params.stdio,
      env: params.env,
      shell: false,
    });

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(normalizeExitCode(code)));
  });
}

export async function handleAttachCommand(argv: string[]): Promise<void> {
  const sessionId = argv[0]?.trim();
  if (!sessionId) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
    console.log('');
    console.log('Usage: happy attach <sessionId>');
    process.exit(1);
  }

  if (!(await isTmuxAvailable())) {
    console.error(chalk.red('Error:'), 'tmux is not available on this machine.');
    process.exit(1);
  }

  const info = await readTerminalAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  });

  if (!info) {
    console.error(chalk.red('Error:'), `No local attachment info found for session ${sessionId}.`);
    console.error(chalk.gray('This usually means the session was not started with tmux, or it was started on another machine.'));
    process.exit(1);
  }

  const plan = createTerminalAttachPlan({
    terminal: info.terminal,
    insideTmux: Boolean(process.env.TMUX),
  });

  if (plan.type === 'not-attachable') {
    console.error(chalk.red('Error:'), plan.reason);
    process.exit(1);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.tmuxCommandEnv };
  if (plan.shouldUnsetTmuxEnv) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }

  const selectExit = await spawnTmux({
    args: plan.selectWindowArgs,
    env,
    stdio: 'ignore',
  });

  if (selectExit !== 0) {
    console.error(chalk.red('Error:'), `Failed to select tmux window (${plan.target}).`);
    process.exit(selectExit);
  }

  if (!plan.shouldAttach) {
    return;
  }

  const attachExit = await spawnTmux({
    args: plan.attachSessionArgs,
    env,
    stdio: 'inherit',
  });
  process.exit(attachExit);
}
