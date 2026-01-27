import type { Session } from '../storageTypes';
import { computeNextSessionSeqFromUpdate } from '../realtimeSessionSeq';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

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

