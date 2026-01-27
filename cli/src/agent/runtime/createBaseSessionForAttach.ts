import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';

export async function createBaseSessionForAttach(opts: {
    existingSessionId: string;
    metadata: Metadata;
    state: AgentState;
}): Promise<ApiSession> {
    const existingSessionId = opts.existingSessionId.trim();
    if (!existingSessionId) {
        throw new Error('Missing existingSessionId');
    }

    const attach = await readSessionAttachFromEnv();
    if (!attach) {
        throw new Error(`Cannot resume session ${existingSessionId}: missing session attach secret`);
    }

    return {
        id: existingSessionId,
        seq: 0,
        encryptionKey: attach.encryptionKey,
        encryptionVariant: attach.encryptionVariant,
        metadata: opts.metadata,
        metadataVersion: -1,
        agentState: opts.state,
        agentStateVersion: -1,
    };
}
