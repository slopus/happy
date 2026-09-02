import type { SessionEnvelope } from '@slopus/happy-wire';
import { trimIdent } from '@/utils/trimIdent';
import type { ReasoningEffort, Thread } from './codexAppServerTypes';
import { isTerminalCodexTurn, mapCodexThreadToSessionEnvelopes } from './utils/sessionProtocolMapper';

type ResumeThreadClient = {
    resumeThread: (opts: {
        threadId: string;
        cwd: string;
        mcpServers: Record<string, unknown>;
    }) => Promise<{ threadId: string; model: string; reasoningEffort: ReasoningEffort | null }>;
    readThread: (opts: {
        threadId: string;
        includeTurns: boolean;
    }) => Promise<{ thread: Pick<Thread, 'turns'> }>;
};

type ResumeThreadSession = {
    sessionId: string;
    getMetadata: () => {
        codexThreadId?: string;
        codexSyncCursor?: { threadId: string; turnId: string };
        codexHistoryReplay?: { threadId: string; startedAt: number };
        codexPawsOriginToken?: string;
    } | null;
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    updateMetadataAndAwait: (handler: (currentMetadata: any) => any) => Promise<void>;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    sendSessionProtocolHistoryAndAwait: (envelopes: readonly SessionEnvelope[]) => Promise<void>;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    historyMode?: 'full' | 'after-cursor';
}): Promise<{
    threadId: string;
    model: string;
    reasoningEffort: ReasoningEffort | null;
    activeTurnId: string | null;
}> {
    try {
        const resumedThread = await opts.client.resumeThread({
            threadId: opts.threadId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers,
        });

        const historyMode = opts.historyMode ?? 'full';
        const initialMetadata = opts.session.getMetadata();
        const interruptedReplay = initialMetadata?.codexHistoryReplay?.threadId === resumedThread.threadId;
        if (historyMode === 'full') {
            // Persist a durable recovery marker before the first batch. If the
            // process or relay fails midway, reconnect can safely replay the
            // whole thread because envelope localIds are deterministic.
            await opts.session.updateMetadataAndAwait((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: resumedThread.threadId,
                codexHistoryReplay: currentMetadata?.codexHistoryReplay?.threadId === resumedThread.threadId
                    ? currentMetadata.codexHistoryReplay
                    : { threadId: resumedThread.threadId, startedAt: Date.now() },
            }));
        } else {
            opts.session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: resumedThread.threadId,
            }));
        }

        let activeTurnId: string | null = null;
        const syncCursor = initialMetadata?.codexSyncCursor;
        const { thread } = await opts.client.readThread({
            threadId: resumedThread.threadId,
            includeTurns: true,
        });
        const turns = thread.turns ?? [];
        let turnsToReplay = turns;
        if (historyMode === 'after-cursor') {
            const cursorIndex = syncCursor?.threadId === resumedThread.threadId
                ? turns.findIndex((turn) => turn.id === syncCursor.turnId)
                : -1;
            // Legacy sessions with neither a cursor nor an interrupted-replay
            // marker still skip old history to avoid duplicating rows written
            // before deterministic envelope localIds existed. A durable marker
            // proves that a partial modern replay is safe to retry in full.
            turnsToReplay = cursorIndex >= 0
                ? turns.slice(cursorIndex + 1)
                : interruptedReplay
                    ? turns
                    : [];
        }
        activeTurnId = turns.filter((turn) => !isTerminalCodexTurn(turn)).at(-1)?.id ?? null;

        const historicalEnvelopes = mapCodexThreadToSessionEnvelopes(
            { turns: turnsToReplay },
            {
                omitPawsUserMessagesFromOriginToken: opts.session.getMetadata()?.codexPawsOriginToken,
                // A reconnect normally catches up durable dialogue only, but
                // an interrupted full replay must reconstruct the exact full
                // envelope set (tools, reasoning, and lifecycle included).
                dialogueOnly: historyMode === 'after-cursor' && !interruptedReplay,
                activeTurnsUserOnly: true,
            },
        );
        await opts.session.sendSessionProtocolHistoryAndAwait(historicalEnvelopes);

        const lastReplayedTurn = turnsToReplay.filter(isTerminalCodexTurn).at(-1);
        if (lastReplayedTurn || historyMode === 'full' || interruptedReplay) {
            // Persist the cursor only after the server has acknowledged all
            // deterministic envelope IDs. A crash can then cause a safe,
            // idempotent replay, but never a silently skipped Turn.
            await opts.session.updateMetadataAndAwait((currentMetadata) => {
                const nextMetadata = { ...currentMetadata };
                if (lastReplayedTurn) {
                    nextMetadata.codexSyncCursor = {
                        threadId: resumedThread.threadId,
                        turnId: lastReplayedTurn.id,
                    };
                }
                if (nextMetadata.codexHistoryReplay?.threadId === resumedThread.threadId) {
                    delete nextMetadata.codexHistoryReplay;
                }
                return nextMetadata;
            });
        }

        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumedThread.threadId)}`, 'status');
        opts.session.sendSessionEvent({
            type: 'message',
            message: `Resumed Codex thread ${resumedThread.threadId}`,
        });

        return { ...resumedThread, activeTurnId };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resume Codex thread ${opts.threadId}: ${reason}`);
    }
}
