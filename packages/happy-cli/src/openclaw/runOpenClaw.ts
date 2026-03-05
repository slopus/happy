import { logger } from '@/ui/logger';
import { Credentials } from '@/persistence';
import { runAcp } from '@/agent/acp';
import { KNOWN_ACP_AGENTS } from '@/agent/acp/acpAgentConfig';

/**
 * Runs OpenClaw as an ACP-based agent through the Happy CLI.
 *
 * OpenClaw natively supports the Agent Client Protocol, so this is a thin
 * wrapper around the generic ACP runner with OpenClaw-specific defaults.
 */
export async function runOpenClaw(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    const config = KNOWN_ACP_AGENTS.openclaw;
    logger.debug(`[openclaw] Starting OpenClaw via ACP: ${config.command} ${config.args.join(' ')}`);

    await runAcp({
        credentials: opts.credentials,
        startedBy: opts.startedBy,
        agentName: 'openclaw',
        command: config.command,
        args: config.args,
    });
}
