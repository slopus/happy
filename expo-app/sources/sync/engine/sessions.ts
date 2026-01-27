import type { NormalizedMessage } from '../typesRaw';
import { normalizeRawMessage } from '../typesRaw';
import { computeNextSessionSeqFromUpdate } from '../realtimeSessionSeq';
import { inferTaskLifecycleFromMessageContent } from './socket';
import type { Session } from '../storageTypes';
import type { Metadata } from '../storageTypes';
import { computeNextReadStateV1 } from '../readStateV1';
import { getServerUrl } from '../serverConfig';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';
import type { ApiMessage } from '../apiTypes';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
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

type SessionListEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

export async function fetchAndApplySessions(params: {
    credentials: AuthCredentials;
    encryption: SessionListEncryption;
    sessionDataKeys: Map<string, Uint8Array>;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1, log } = params;

    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/sessions`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch sessions (${response.status})`, false);
        }
        throw new Error(`Failed to fetch sessions: ${response.status}`);
    }

    const data = await response.json();
    const sessions = data.sessions as Array<{
        id: string;
        tag: string;
        seq: number;
        metadata: string;
        metadataVersion: number;
        agentState: string | null;
        agentStateVersion: number;
        dataEncryptionKey: string | null;
        active: boolean;
        activeAt: number;
        createdAt: number;
        updatedAt: number;
        lastMessage: ApiMessage | null;
    }>;

    // Initialize all session encryptions first
    const sessionKeys = new Map<string, Uint8Array | null>();
    for (const session of sessions) {
        if (session.dataEncryptionKey) {
            const decrypted = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
            if (!decrypted) {
                console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                continue;
            }
            sessionKeys.set(session.id, decrypted);
            sessionDataKeys.set(session.id, decrypted);
        } else {
            sessionKeys.set(session.id, null);
            sessionDataKeys.delete(session.id);
        }
    }
    await encryption.initializeSessions(sessionKeys);

    // Decrypt sessions
    const decryptedSessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[] = [];
    for (const session of sessions) {
        // Get session encryption (should always exist after initialization)
        const sessionEncryption = encryption.getSessionEncryption(session.id);
        if (!sessionEncryption) {
            console.error(`Session encryption not found for ${session.id} - this should never happen`);
            continue;
        }

        // Decrypt metadata using session-specific encryption
        const metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

        // Decrypt agent state using session-specific encryption
        const agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);

        // Put it all together
        decryptedSessions.push({
            ...session,
            thinking: false,
            thinkingAt: 0,
            metadata,
            agentState,
        });
    }

    // Apply to storage
    applySessions(decryptedSessions);
    log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);

    void (async () => {
        for (const session of decryptedSessions) {
            const readState = session.metadata?.readStateV1;
            if (!readState) continue;
            if (readState.sessionSeq <= session.seq) continue;
            await repairInvalidReadStateV1({ sessionId: session.id, sessionSeqUpperBound: session.seq });
        }
    })();
}

type SessionMessagesEncryption = {
    decryptMessages: (messages: ApiMessage[]) => Promise<any[]>;
};

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Set<string>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    markMessagesLoaded: (sessionId: string) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { sessionId, getSessionEncryption, request, sessionReceivedMessages, applyMessages, markMessagesLoaded, log } =
        params;

    log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);

    // Get encryption - may not be ready yet if session was just created
    // Throwing an error triggers backoff retry in InvalidateSync
    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    // Request (apiSocket.request calibrates server time best-effort from the HTTP Date header)
    const response = await request(`/v1/sessions/${sessionId}/messages`);
    const data = await response.json();

    // Collect existing messages
    let eixstingMessages = sessionReceivedMessages.get(sessionId);
    if (!eixstingMessages) {
        eixstingMessages = new Set<string>();
        sessionReceivedMessages.set(sessionId, eixstingMessages);
    }

    // Decrypt and normalize messages
    const normalizedMessages: NormalizedMessage[] = [];

    // Filter out existing messages and prepare for batch decryption
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...(data.messages as ApiMessage[])].reverse()) {
        if (!eixstingMessages.has(msg.id)) {
            messagesToDecrypt.push(msg);
        }
    }

    // Batch decrypt all messages at once
    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    // Process decrypted messages
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            eixstingMessages.add(decrypted.id);
            // Normalize the decrypted message
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
    }

    // Apply to storage
    applyMessages(sessionId, normalizedMessages);
    markMessagesLoaded(sessionId);
    log.log(`💬 fetchMessages completed for session ${sessionId} - processed ${normalizedMessages.length} messages`);
}
