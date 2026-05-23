/**
 * Hermes CLI Entry Point
 *
 * This module provides the main entry point for running the Hermes Agent
 * through Happy CLI. It is a thin wrapper around the generic ACP runner,
 * since Hermes Agent natively supports the Agent Client Protocol via
 * `hermes acp` (requires `pip install 'hermes-agent[acp]'`).
 *
 * Performs a pre-flight check that the `hermes` binary is on PATH and
 * prints an install hint if missing — Hermes is a separate Python package
 * that the user must install themselves.
 */

import { execSync } from 'node:child_process';
import os from 'node:os';

import chalk from 'chalk';

import { runAcp } from '@/agent/acp';
import type { Credentials } from '@/persistence';

/**
 * Check whether the `hermes` CLI is available on PATH.
 *
 * Exported so the `happy hermes` subcommand handler can pre-flight the check
 * before triggering auth / daemon setup — first-time users without Hermes
 * installed should NOT be dragged through the QR flow just to hit an
 * install-hint error.
 */
export function hermesCliAvailable(): boolean {
  const isWindows = os.platform() === 'win32';
  try {
    if (isWindows) {
      execSync('powershell -NoProfile -Command "Get-Command hermes -ErrorAction SilentlyContinue"', {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      execSync('command -v hermes >/dev/null 2>&1', { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Print the install hint for Hermes Agent and exit with code 1.
 */
export function printHermesMissingAndExit(): never {
  console.error(chalk.red('Error:'), '`hermes` CLI not found on PATH.');
  console.error('');
  console.error('Hermes Agent is a Python package from Nous Research.');
  console.error('Install with ACP support:');
  console.error('');
  console.error(chalk.cyan("  pip install 'hermes-agent[acp]'"));
  console.error('');
  console.error('Or use uv:');
  console.error('');
  console.error(chalk.cyan("  uvx --from 'hermes-agent[acp]' hermes-acp"));
  console.error('');
  console.error('See https://github.com/NousResearch/hermes-agent for setup.');
  process.exit(1);
}

export async function runHermes(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
}): Promise<void> {
  // Defense-in-depth: the subcommand handler also checks this before auth,
  // but re-check here in case runHermes is invoked from another code path.
  if (!hermesCliAvailable()) {
    printHermesMissingAndExit();
  }

  await runAcp({
    credentials: opts.credentials,
    startedBy: opts.startedBy,
    verbose: opts.verbose,
    agentName: 'hermes',
    command: 'hermes',
    args: ['acp'],
  });
}
