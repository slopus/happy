import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['login', 'status'],
} satisfies CliDetectSpec;

