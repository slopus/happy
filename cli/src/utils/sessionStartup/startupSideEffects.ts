import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { writeTerminalAttachmentInfo } from '@/terminal/terminalAttachmentInfo';
import { buildTerminalFallbackMessage } from '@/terminal/terminalFallbackMessage';
import { logger } from '@/ui/logger';

export function primeAgentStateForUi(session: ApiSessionClient, logPrefix: string): void {
    // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
    // The server does not currently persist agentState during initial session creation; it starts at version 0
    // and only changes via 'update-state'. The UI uses agentStateVersion > 0 as its readiness signal.
    try {
        session.updateAgentState((currentState) => ({ ...currentState }));
    } catch (e) {
        logger.debug(`${logPrefix} Failed to prime agent state (non-fatal)`, e);
    }
}

export async function persistTerminalAttachmentInfoIfNeeded(opts: {
    sessionId: string;
    terminal: Metadata['terminal'] | undefined;
}): Promise<void> {
    if (!opts.terminal) return;
    try {
        await writeTerminalAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: opts.sessionId,
            terminal: opts.terminal,
        });
    } catch (error) {
        logger.debug('[START] Failed to persist terminal attachment info', error);
    }
}

export function sendTerminalFallbackMessageIfNeeded(opts: {
    session: ApiSessionClient;
    terminal: Metadata['terminal'] | undefined;
}): void {
    if (!opts.terminal) return;
    const fallbackMessage = buildTerminalFallbackMessage(opts.terminal);
    if (!fallbackMessage) return;
    opts.session.sendSessionEvent({ type: 'message', message: fallbackMessage });
}

export async function reportSessionToDaemonIfRunning(opts: {
    sessionId: string;
    metadata: Metadata;
}): Promise<void> {
    try {
        logger.debug(`[START] Reporting session ${opts.sessionId} to daemon`);
        const result = await notifyDaemonSessionStarted(opts.sessionId, opts.metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${opts.sessionId} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }
}

