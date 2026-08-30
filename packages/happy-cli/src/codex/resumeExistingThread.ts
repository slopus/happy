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
        codexPawsOriginToken?: string;
    } | null;
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    updateMetadataAndAwait: (handler: (currentMetadata: any) => any) => Promise<void>;
    flushOutboxAndAwait: () => Promise<void>;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    sendSessionProtocolMessage: (envelope: SessionEnvelope) => void;
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

        opts.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            codexThreadId: resumedThread.threadId,
        }));

        const historyMode = opts.historyMode ?? 'full';
        let activeTurnId: string | null = null;
        const syncCursor = opts.session.getMetadata()?.codexSyncCursor;
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
            // Legacy sessions have no cursor, and a missing cursor cannot be
            // reconciled safely without duplicating already mirrored turns. We
            // still read the thread so an in-flight Turn can be attached live.
            turnsToReplay = cursorIndex >= 0 ? turns.slice(cursorIndex + 1) : [];
        }
        activeTurnId = turns.filter((turn) => !isTerminalCodexTurn(turn)).at(-1)?.id ?? null;

        const historicalEnvelopes = mapCodexThreadToSessionEnvelopes(
            { turns: turnsToReplay },
            {
                omitPawsUserMessagesFromOriginToken: opts.session.getMetadata()?.codexPawsOriginToken,
                dialogueOnly: historyMode === 'after-cursor',
                activeTurnsUserOnly: true,
            },
        );
        for (const envelope of historicalEnvelopes) {
            opts.session.sendSessionProtocolMessage(envelope);
        }

        const lastReplayedTurn = turnsToReplay.filter(isTerminalCodexTurn).at(-1);
        if (lastReplayedTurn) {
            // Persist the cursor only after the server has acknowledged all
            // deterministic envelope IDs. A crash can then cause a safe,
            // idempotent replay, but never a silently skipped Turn.
            await opts.session.flushOutboxAndAwait();
            await opts.session.updateMetadataAndAwait((currentMetadata) => ({
                ...currentMetadata,
                codexSyncCursor: {
                    threadId: resumedThread.threadId,
                    turnId: lastReplayedTurn.id,
                },
            }));
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
