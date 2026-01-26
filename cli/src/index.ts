#!/usr/bin/env node

/**
 * CLI entry point for happy command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { dispatchCli } from '@/cli/dispatch';
import { parseCliArgs } from '@/cli/parseArgs';

void (async () => {
  const { args, terminalRuntime } = parseCliArgs(process.argv.slice(2));
  await dispatchCli({ args, terminalRuntime, rawArgv: process.argv });
})();

