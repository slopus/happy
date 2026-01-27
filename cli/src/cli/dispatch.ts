import chalk from 'chalk';
import { logger } from '@/ui/logger';
import type { TerminalRuntimeFlags } from '@/terminal/terminalRuntimeFlags';
import { commandRegistry } from '@/cli/commandRegistry';
import { AGENTS } from '@/backends/catalog';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';

export async function dispatchCli(params: Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  rawArgv: string[];
}>): Promise<void> {
  const { args, terminalRuntime, rawArgv } = params;

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', rawArgv);
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];

  // Headless tmux launcher (CLI flow)
  if (args.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (args.includes('-h') || args.includes('--help') || args.includes('-v') || args.includes('--version')) {
      const idx = args.indexOf('--tmux');
      if (idx !== -1) args.splice(idx, 1);
    } else {
      const disallowed = new Set(['doctor', 'auth', 'connect', 'notify', 'daemon', 'install', 'uninstall', 'logout', 'attach']);
      if (subcommand && disallowed.has(subcommand)) {
        console.error(chalk.red('Error:'), '--tmux can only be used when starting a session.');
        process.exit(1);
      }

      try {
        const { startHappyHeadlessInTmux } = await import('@/terminal/startHappyHeadlessInTmux');
        await startHappyHeadlessInTmux(args);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        if (process.env.DEBUG) {
          console.error(error)
        }
        process.exit(1)
      }
      return;
    }
  }
  const commandHandler = (subcommand ? commandRegistry[subcommand] : undefined);
  if (commandHandler) {
    await commandHandler({ args, rawArgv, terminalRuntime });
    return;
  }

  const defaultEntry = AGENTS[DEFAULT_CATALOG_AGENT_ID];
  if (!defaultEntry.getCliCommandHandler) {
    throw new Error(`Default agent '${DEFAULT_CATALOG_AGENT_ID}' has no CLI command handler registered`);
  }
  const defaultHandler = await defaultEntry.getCliCommandHandler();
  await defaultHandler({ args, rawArgv, terminalRuntime });
}
