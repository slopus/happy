import type { NormalizedMessage } from '../typesRaw';
import { normalizeRawMessage } from '../typesRaw';
import { computeNextSessionSeqFromUpdate } from '../realtimeSessionSeq';
import { inferTaskLifecycleFromMessageContent } from './socket';
import type { Session } from '../storageTypes';
import type { Metadata } from '../storageTypes';
import { computeNextReadStateV1 } from '../readStateV1';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

type SessionEncryption = {
    decryptAgentState: (version: number, value: string) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

export async function handleNewMessageSocketUpdate(params: {
    updateData: any;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    isMutableToolCall: (sessionId: string, toolUseId: string) => boolean;
    invalidateGitStatus: (sessionId: string) => void;
    onSessionVisible: (sessionId: string) => void;
}): Promise<void> {
    const {
        updateData,
        getSessionEncryption,
        getSession,
        applySessions,
        fetchSessions,
        applyMessages,
        isMutableToolCall,
        invalidateGitStatus,
        onSessionVisible,
    } = params;

    // Get encryption
    const encryption = getSessionEncryption(updateData.body.sid);
    if (!encryption) {
        // Should never happen
        console.error(`Session ${updateData.body.sid} not found`);
        fetchSessions(); // Just fetch sessions again
        return;
    }

    // Decrypt message
    let lastMessage: NormalizedMessage | null = null;
    if (updateData.body.message) {
        const decrypted = await encryption.decryptMessage(updateData.body.message);
        if (decrypted) {
            lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);

            // Check for task lifecycle events to update thinking state.
            // This ensures UI updates even if volatile activity updates are lost.
            const { isTaskComplete, isTaskStarted } = inferTaskLifecycleFromMessageContent(decrypted.content);

            // Update session
            const session = getSession(updateData.body.sid);
            if (session) {
                const nextSessionSeq = computeNextSessionSeqFromUpdate({
                    currentSessionSeq: session.seq ?? 0,
                    updateType: 'new-message',
                    containerSeq: updateData.seq,
                    messageSeq: updateData.body.message?.seq,
                });

                applySessions([
                    {
                        ...session,
                        updatedAt: updateData.createdAt,
                        seq: nextSessionSeq,
                        // Update thinking state based on task lifecycle events
                        ...(isTaskComplete ? { thinking: false } : {}),
                        ...(isTaskStarted ? { thinking: true } : {}),
                    },
                ]);
            } else {
                // Fetch sessions again if we don't have this session
                fetchSessions();
            }

            // Update messages
            if (lastMessage) {
                applyMessages(updateData.body.sid, [lastMessage]);
                let hasMutableTool = false;
                if (lastMessage.role === 'agent' && lastMessage.content[0] && lastMessage.content[0].type === 'tool-result') {
                    hasMutableTool = isMutableToolCall(updateData.body.sid, lastMessage.content[0].tool_use_id);
                }
                if (hasMutableTool) {
                    invalidateGitStatus(updateData.body.sid);
                }
            }
        }
    }

    // Ping session
    onSessionVisible(updateData.body.sid);
}

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    deleteSession: (sessionId: string) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearGitStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const { sessionId, deleteSession, removeSessionEncryption, removeProjectManagerSession, clearGitStatusForSession, log } = params;

    // Remove session from storage
    deleteSession(sessionId);

    // Remove encryption keys from memory
    removeSessionEncryption(sessionId);

    // Remove from project manager
    removeProjectManagerSession(sessionId);

    // Clear any cached git status
    clearGitStatusForSession(sessionId);

    log.log(`🗑️ Session ${sessionId} deleted from local storage`);
}

export async function buildUpdatedSessionFromSocketUpdate(params: {
    session: Session;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: SessionEncryption;
}): Promise<{ nextSession: Session; agentState: any }> {
    const { session, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;

    const agentState = updateBody.agentState
        ? await sessionEncryption.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
        : session.agentState;

    const metadata = updateBody.metadata
        ? await sessionEncryption.decryptMetadata(updateBody.metadata.version, updateBody.metadata.value)
        : session.metadata;

    const nextSession: Session = {
        ...session,
        agentState,
        agentStateVersion: updateBody.agentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata,
        metadataVersion: updateBody.metadata ? updateBody.metadata.version : session.metadataVersion,
        updatedAt: updateCreatedAt,
        seq: computeNextSessionSeqFromUpdate({
            currentSessionSeq: session.seq ?? 0,
            updateType: 'update-session',
            containerSeq: updateSeq,
            messageSeq: undefined,
        }),
    };

    return { nextSession, agentState };
}

export async function repairInvalidReadStateV1(params: {
    sessionId: string;
    sessionSeqUpperBound: number;
    attempted: Set<string>;
    inFlight: Set<string>;
    getSession: (sessionId: string) => { metadata?: Metadata | null } | undefined;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
    now: () => number;
}): Promise<void> {
    const { sessionId, sessionSeqUpperBound, attempted, inFlight, getSession, updateSessionMetadataWithRetry, now } = params;

    if (attempted.has(sessionId) || inFlight.has(sessionId)) {
        return;
    }

    const session = getSession(sessionId);
    const readState = session?.metadata?.readStateV1;
    if (!readState) return;
    if (readState.sessionSeq <= sessionSeqUpperBound) return;

    attempted.add(sessionId);
    inFlight.add(sessionId);
    try {
        await updateSessionMetadataWithRetry(sessionId, (metadata) => {
            const prev = metadata.readStateV1;
            if (!prev) return metadata;
            if (prev.sessionSeq <= sessionSeqUpperBound) return metadata;

            const result = computeNextReadStateV1({
                prev,
                sessionSeq: sessionSeqUpperBound,
                pendingActivityAt: prev.pendingActivityAt,
                now: now(),
            });
            if (!result.didChange) return metadata;
            return { ...metadata, readStateV1: result.next };
        });
    } catch {
        // ignore
    } finally {
        inFlight.delete(sessionId);
    }
}
