import chalk from 'chalk';

import { handleAttachCommand } from '@/commands/attach';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleAttachCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAttachCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

