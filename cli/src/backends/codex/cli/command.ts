import chalk from 'chalk';

import { CODEX_PERMISSION_MODES, isCodexPermissionMode } from '@/api/types';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { parseSessionStartArgs } from '@/cli/sessionStartArgs';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleCodexCliCommand(context: CommandContext): Promise<void> {
  try {
    const { runCodex } = await import('@/backends/codex/runCodex');

    const { startedBy, permissionMode, permissionModeUpdatedAt } = parseSessionStartArgs(context.args);
    if (permissionMode && !isCodexPermissionMode(permissionMode)) {
      console.error(
        chalk.red(
          `Invalid --permission-mode for codex: ${permissionMode}. Valid values: ${CODEX_PERMISSION_MODES.join(', ')}`,
        ),
      );
      console.error(chalk.gray('Tip: use --yolo for full bypass-like behavior.'));
      process.exit(1);
    }

    const readFlagValue = (flag: string): string | undefined => {
      const idx = context.args.indexOf(flag);
      if (idx === -1) return undefined;
      const value = context.args[idx + 1];
      if (!value || value.startsWith('-')) return undefined;
      return value;
    };

    const existingSessionId = readFlagValue('--existing-session');
    const resume = readFlagValue('--resume');

    const { credentials } = await authAndSetupMachineIfNeeded();
    await runCodex({
      credentials,
      startedBy,
      terminalRuntime: context.terminalRuntime,
      permissionMode,
      permissionModeUpdatedAt,
      existingSessionId,
      resume,
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
