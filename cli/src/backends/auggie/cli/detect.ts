import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  // Avoid probing login status by default (some commands may print sensitive tokens).
  loginStatusArgs: null,
} satisfies CliDetectSpec;

