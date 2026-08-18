import type { SessionMetadataPatch } from './storageTypes';

/**
 * Tracks per-session metadata fields that have an optimistic push in flight.
 * While a push is pending the local value is newer than anything the server
 * can echo back, so applySessions must not resolve those fields from inbound
 * (stale) metadata — otherwise the change visibly bounces back: an agent-mode
 * pick reverts and a message sent in that window carries the old mode, and a
 * pinned session unpins itself under the user.
 *
 * Lives in its own module so both ops.ts (writer) and storage.ts (reader) can
 * use it without an import cycle. Counters (not booleans) so overlapping
 * pushes for the same field don't clear each other's pending state.
 */
export type PendingMetadataField = keyof SessionMetadataPatch;

const pendingBySession = new Map<string, Map<PendingMetadataField, number>>();

export function markMetadataPushPending(sessionId: string, fields: PendingMetadataField[]): void {
    let counters = pendingBySession.get(sessionId);
    if (!counters) {
        counters = new Map();
        pendingBySession.set(sessionId, counters);
    }
    for (const field of fields) {
        counters.set(field, (counters.get(field) ?? 0) + 1);
    }
}

export function clearMetadataPushPending(sessionId: string, fields: PendingMetadataField[]): void {
    const counters = pendingBySession.get(sessionId);
    if (!counters) {
        return;
    }
    for (const field of fields) {
        const count = counters.get(field) ?? 0;
        if (count <= 1) {
            counters.delete(field);
        } else {
            counters.set(field, count - 1);
        }
    }
    if (counters.size === 0) {
        pendingBySession.delete(sessionId);
    }
}

export function isMetadataPushPending(sessionId: string, field: PendingMetadataField): boolean {
    return (pendingBySession.get(sessionId)?.get(field) ?? 0) > 0;
}
