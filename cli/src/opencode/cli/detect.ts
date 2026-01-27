import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['auth', 'list'],
} satisfies CliDetectSpec;

