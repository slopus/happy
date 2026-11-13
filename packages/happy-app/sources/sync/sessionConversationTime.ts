import { normalizeRawMessage } from './typesRaw';
import type { AgentState, DecryptedMessage } from './storageTypes';
import type { ApiSessionSnapshot } from './apiTypes';

/** Thread replay preserves envelope.time; service/presence events are not conversation activity. */
export function getConversationMessageTime(message: DecryptedMessage | null): number | null {
    if (!message?.content) return null;
    const raw = message.content;
    const envelope = raw.role === 'session' ? raw.content?.data ?? raw.content
        : raw.content?.type === 'session' ? raw.content.data : null;
    if (envelope?.subagent || envelope?.ev?.t === 'service') return null;
    if (envelope?.ev?.t === 'turn-start' || envelope?.ev?.t === 'turn-end') {
        return Number.isFinite(envelope.time) ? envelope.time : null;
    }
    const normalized = normalizeRawMessage(message.id, message.localId, message.createdAt, raw);
    if (!normalized || normalized.isSidechain) return null;
    if (normalized.role === 'user' || normalized.role === 'agent'
        || normalized.role === 'event' && normalized.content.type === 'ready' && normalized.content.terminal === true) {
        return normalized.createdAt;
    }
    return null;
}

export function getSnapshotConversationTime(snapshot: ApiSessionSnapshot, agentState: AgentState | null, tail: DecryptedMessage | null): number | null {
    const turnTime = agentState?.turnStatus?.updatedAt ?? 0;
    const messageTime = getConversationMessageTime(tail) ?? 0;
    // Leave unknown clocks unset: importing old history can legitimately predate the new shell.
    return Math.max(turnTime, messageTime, snapshot.lastMessageAt ?? 0) || null;
}
