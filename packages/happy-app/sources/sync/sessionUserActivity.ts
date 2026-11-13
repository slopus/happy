import { normalizeRawMessage } from './typesRaw';
import type { DecryptedMessage, Metadata } from './storageTypes';
import type { ApiSessionSnapshot } from './apiTypes';

/** Only an explicitly submitted, encrypted user marker owns navigation recency.
 * Legacy history and agent output must never infer a fresh user interaction. */
export function getUserMessageTime(message: DecryptedMessage | null): number | null {
    if (!message?.content) return null;
    const raw = message.content;
    const envelope = raw.role === 'session' ? raw.content?.data ?? raw.content
        : raw.content?.type === 'session' ? raw.content.data : null;
    if (envelope?.subagent) return null;
    const normalized = normalizeRawMessage(message.id, message.localId, message.createdAt, message.content);
    const at = normalized?.meta?.userSentAt;
    return normalized?.role === 'user' && !normalized.isSidechain
        && typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
}

export function getSnapshotUserMessageTime(
    snapshot: ApiSessionSnapshot, metadata: Metadata | null, tail: DecryptedMessage | null,
): number | null {
    return Math.max(snapshot.lastUserMessageAt ?? 0, metadata?.lastUserMessageAt ?? 0, getUserMessageTime(tail) ?? 0) || null;
}
