import type { HeadlessTmuxArgvTransform } from '@/backends/types';
import { ensureRemoteStartingModeArgs } from '@/terminal/headlessTmuxArgs';

export const claudeHeadlessTmuxArgvTransform: HeadlessTmuxArgvTransform = (argv) => {
  return ensureRemoteStartingModeArgs(argv);
};

