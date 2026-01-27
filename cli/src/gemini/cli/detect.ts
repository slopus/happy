import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['auth', 'status'],
} satisfies CliDetectSpec;

