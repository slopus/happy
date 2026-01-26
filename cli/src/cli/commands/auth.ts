import chalk from 'chalk';

import { handleAuthCommand } from '@/commands/auth';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleAuthCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAuthCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

