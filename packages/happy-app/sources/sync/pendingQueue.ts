import type { PendingMessage } from './storageTypes';

function comparePendingQueue(a: PendingMessage, b: PendingMessage): number {
    if (a.pinnedAt !== null || b.pinnedAt !== null) {
        if (a.pinnedAt === null) return 1;
        if (b.pinnedAt === null) return -1;
        if (a.pinnedAt !== b.pinnedAt) {
            return b.pinnedAt - a.pinnedAt;
        }
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
    }

    return a.id.localeCompare(b.id);
}

export function sortPendingQueue(queue: PendingMessage[]): PendingMessage[] {
    return [...queue].sort(comparePendingQueue);
}

export function upsertPendingMessageInQueue(queue: PendingMessage[], pending: PendingMessage): PendingMessage[] {
    const next = queue.filter((item) => item.id !== pending.id);
    next.push(pending);
    return sortPendingQueue(next);
}

export function removePendingMessageFromQueue(queue: PendingMessage[], pendingId: string): PendingMessage[] {
    return queue.filter((item) => item.id !== pendingId);
}
