import chalk from 'chalk';
import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@/api/types';

export function parseSessionStartArgs(args: string[]): {
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
} {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let permissionMode: PermissionMode | undefined = undefined;
  let permissionModeUpdatedAt: number | undefined = undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--started-by') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --started-by (expected: daemon|terminal)'));
        process.exit(1);
      }
      const value = args[++i];
      if (value !== 'daemon' && value !== 'terminal') {
        console.error(chalk.red(`Invalid --started-by value: ${value}. Expected: daemon|terminal`));
        process.exit(1);
      }
      startedBy = value;
    } else if (arg === '--permission-mode') {
      if (i + 1 >= args.length) {
        console.error(chalk.red(`Missing value for --permission-mode. Valid values: ${PERMISSION_MODES.join(', ')}`));
        process.exit(1);
      }
      const value = args[++i];
      if (!isPermissionMode(value)) {
        console.error(chalk.red(`Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_MODES.join(', ')}`));
        process.exit(1);
      }
      permissionMode = value;
    } else if (arg === '--permission-mode-updated-at') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --permission-mode-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = args[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --permission-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      permissionModeUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--yolo') {
      permissionMode = 'yolo';
    }
  }

  return { startedBy, permissionMode, permissionModeUpdatedAt };
}
