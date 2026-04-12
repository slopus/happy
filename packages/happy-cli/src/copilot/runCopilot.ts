/**
 * GitHub Copilot CLI Entry Point
 *
 * Runs the GitHub Copilot coding agent (`gh copilot --acp`) as a Happy session.
 * Authentication is provided via a GitHub OAuth token stored in Happy cloud
 * (run `happy connect copilot` once to set it up).
 *
 * The daemon spawns this as:
 *   `node dist/index.mjs copilot --started-by daemon`
 */

import { execSync } from 'node:child_process';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials } from '@/persistence';
import { runAcp } from '@/agent/acp/runAcp';

/**
 * Verify that the `gh` CLI is installed and that the `copilot` extension is available.
 * Exits the process with a helpful message if not.
 */
function assertCopilotInstalled(): void {
    try {
        execSync('gh --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mGitHub CLI (gh) is not installed\x1b[0m\n');
        console.error('Install it from: https://cli.github.com\n');
        console.error('Then install the Copilot extension:');
        console.error('  \x1b[36mgh extension install github/gh-copilot\x1b[0m\n');
        process.exit(1);
    }

    try {
        execSync('gh copilot --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mGitHub Copilot extension for gh is not installed\x1b[0m\n');
        console.error('Install it with:');
        console.error('  \x1b[36mgh extension install github/gh-copilot\x1b[0m\n');
        console.error('Alternatively, use Claude Code or Codex:');
        console.error('  \x1b[36mhappy claude\x1b[0m  or  \x1b[36mhappy codex\x1b[0m\n');
        process.exit(1);
    }
}

/**
 * Inject the GitHub OAuth token from Happy cloud into the process environment
 * so that `gh copilot` can authenticate without requiring a separate `gh auth login`.
 */
async function injectCloudToken(credentials: Credentials): Promise<void> {
    try {
        const api = await ApiClient.create(credentials);
        const vendorToken = await api.getVendorToken('copilot');
        if (vendorToken?.oauth?.access_token) {
            process.env.GH_TOKEN = vendorToken.oauth.access_token;
            logger.debug('[Copilot] Injected GitHub OAuth token from Happy cloud');
        }
    } catch (error) {
        logger.debug('[Copilot] Could not fetch cloud token (will rely on local gh auth):', error);
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

    await injectCloudToken(opts.credentials);

    await runAcp({
        credentials: opts.credentials,
        agentName: 'copilot',
        command: 'gh',
        args: ['copilot', '--acp'],
        startedBy: opts.startedBy,
    });
}
