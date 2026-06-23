/**
 * Kimi CLI Entry Point
 *
 * This module provides the main entry point for running the Kimi agent
 * through Happy CLI. It is a thin wrapper around the generic ACP runner,
 * since Kimi CLI natively supports the Agent Client Protocol via `kimi acp`.
 */

import { runAcp } from '@/agent/acp';
import type { Credentials } from '@/persistence';

export async function runKimi(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
}): Promise<void> {
  await runAcp({
    credentials: opts.credentials,
    startedBy: opts.startedBy,
    verbose: opts.verbose,
    agentName: 'kimi',
    command: 'kimi',
    args: ['acp'],
  });
}
