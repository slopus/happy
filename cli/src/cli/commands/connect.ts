import chalk from 'chalk';

import { handleConnectCommand } from '@/commands/connect';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleConnectCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

