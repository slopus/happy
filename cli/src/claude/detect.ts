import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version']],
  loginStatusArgs: null,
} satisfies CliDetectSpec;

