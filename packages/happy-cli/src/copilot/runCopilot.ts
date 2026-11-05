/**
 * Copilot CLI Entry Point
 *
 * Runs the Copilot coding agent (`copilot --acp`) as a Happy session.
 * The `copilot` binary manages its own authentication (run `copilot login`
 * to sign in), just like `claude` handles its own auth.
 *
 * The daemon spawns this as:
 *   `node dist/index.mjs copilot --started-by daemon`
 */

import { execSync } from 'node:child_process';
import { Credentials } from '@/persistence';
import { runAcp } from '@/agent/acp/runAcp';

/**
 * Verify that the standalone `copilot` CLI is installed.
 * Exits the process with a helpful message if not.
 */
export function assertCopilotInstalled(): void {
    try {
        execSync('copilot --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCopilot CLI is not installed or not in PATH\x1b[0m\n');
        console.error('Install it from: https://github.com/github/copilot-cli\n');
        console.error('Then authenticate:');
        console.error('  \x1b[36mcopilot login\x1b[0m\n');
        console.error('Alternatively, use Claude Code or Codex:');
        console.error('  \x1b[36mhappy claude\x1b[0m  or  \x1b[36mhappy codex\x1b[0m\n');
        process.exit(1);
    }
}

/**
 * Main entry point for `happy copilot`.
 */
export async function runCopilot(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    assertCopilotInstalled();

    await runAcp({
        credentials: opts.credentials,
        agentName: 'copilot',
        command: 'copilot',
        args: ['--acp'],
        startedBy: opts.startedBy,
    });
}
