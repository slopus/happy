import type { Metadata } from './storageTypes';

export type MessageQueueV1Item = {
    localId: string;
    message: string;
    createdAt: number;
    updatedAt: number;
};

export type MessageQueueV1InFlight = MessageQueueV1Item & {
    claimedAt: number;
};

export type MessageQueueV1DiscardedReason = 'switch_to_local' | 'manual';

export type MessageQueueV1DiscardedItem = MessageQueueV1Item & {
    discardedAt: number;
    discardedReason: MessageQueueV1DiscardedReason;
};

export type MessageQueueV1 = {
    v: 1;
    queue: MessageQueueV1Item[];
    inFlight?: MessageQueueV1InFlight | null;
};

function ensureQueue(metadata: Metadata): MessageQueueV1 {
    const existing = metadata.messageQueueV1;
    if (existing && existing.v === 1 && Array.isArray(existing.queue)) {
        return existing;
    }
    return { v: 1, queue: [] };
}

export function enqueueMessageQueueV1Item(metadata: Metadata, item: MessageQueueV1Item): Metadata {
    const mq = ensureQueue(metadata);
    const existingIndex = mq.queue.findIndex((q) => q.localId === item.localId);
    const nextQueue =
        existingIndex >= 0
            ? [...mq.queue.slice(0, existingIndex), item, ...mq.queue.slice(existingIndex + 1)]
            : [...mq.queue, item];
    return {
        ...metadata,
        messageQueueV1: {
            ...mq,
            v: 1,
            queue: nextQueue,
        },
    };
}

export function updateMessageQueueV1Item(metadata: Metadata, item: MessageQueueV1Item): Metadata {
    const mq = ensureQueue(metadata);
    const existingIndex = mq.queue.findIndex((q) => q.localId === item.localId);
    if (existingIndex < 0) {
        return metadata;
    }
    const nextQueue = [...mq.queue.slice(0, existingIndex), item, ...mq.queue.slice(existingIndex + 1)];
    return {
        ...metadata,
        messageQueueV1: {
            ...mq,
            v: 1,
            queue: nextQueue,
        },
    };
}

export function deleteMessageQueueV1Item(metadata: Metadata, localId: string): Metadata {
    const mq = ensureQueue(metadata);
    const nextQueue = mq.queue.filter((q) => q.localId !== localId);
    return {
        ...metadata,
        messageQueueV1: {
            ...mq,
            v: 1,
            queue: nextQueue,
        },
    };
}

export function discardMessageQueueV1All(
    metadata: Metadata,
    opts: { discardedAt: number; discardedReason: MessageQueueV1DiscardedReason; maxDiscarded?: number }
): { metadata: Metadata; discarded: MessageQueueV1DiscardedItem[] } {
    const mq = ensureQueue(metadata);
    const existingDiscarded = metadata.messageQueueV1Discarded ?? [];
    const maxDiscarded = opts.maxDiscarded ?? 50;

    const discardFromQueue = mq.queue.map((q) => ({
        ...q,
        discardedAt: opts.discardedAt,
        discardedReason: opts.discardedReason,
    }));
    const discardFromInFlight = mq.inFlight
        ? [{
            localId: mq.inFlight.localId,
            message: mq.inFlight.message,
            createdAt: mq.inFlight.createdAt,
            updatedAt: mq.inFlight.updatedAt,
            discardedAt: opts.discardedAt,
            discardedReason: opts.discardedReason,
        }]
        : [];

    const discarded = [...discardFromInFlight, ...discardFromQueue];
    if (discarded.length === 0) {
        return { metadata, discarded: [] };
    }

    const nextDiscarded = [...existingDiscarded, ...discarded].slice(-maxDiscarded);
    return {
        metadata: {
            ...metadata,
            messageQueueV1: {
                ...mq,
                queue: [],
                inFlight: null,
            },
            messageQueueV1Discarded: nextDiscarded,
        },
        discarded,
    };
}

export function discardMessageQueueV1Item(
    metadata: Metadata,
    opts: { localId: string; discardedAt: number; discardedReason: MessageQueueV1DiscardedReason; maxDiscarded?: number }
): Metadata {
    const mq = ensureQueue(metadata);
    const existingDiscarded = metadata.messageQueueV1Discarded ?? [];
    const maxDiscarded = opts.maxDiscarded ?? 50;

    const queueIndex = mq.queue.findIndex((q) => q.localId === opts.localId);
    const queueItem = queueIndex >= 0 ? mq.queue[queueIndex] : null;

    const inFlightItem = mq.inFlight && mq.inFlight.localId === opts.localId
        ? mq.inFlight
        : null;

    if (!queueItem && !inFlightItem) {
        return metadata;
    }

    const item: MessageQueueV1Item = queueItem
        ? queueItem
        : {
            localId: inFlightItem!.localId,
            message: inFlightItem!.message,
            createdAt: inFlightItem!.createdAt,
            updatedAt: inFlightItem!.updatedAt,
        };

    const discardedItem: MessageQueueV1DiscardedItem = {
        ...item,
        discardedAt: opts.discardedAt,
        discardedReason: opts.discardedReason,
    };

    const nextQueue = queueItem
        ? [...mq.queue.slice(0, queueIndex), ...mq.queue.slice(queueIndex + 1)]
        : mq.queue;

    const next: MessageQueueV1 = {
        ...mq,
        v: 1,
        queue: nextQueue,
    };
    if (mq.inFlight !== undefined) {
        next.inFlight = inFlightItem ? null : mq.inFlight;
    }

    return {
        ...metadata,
        messageQueueV1: next,
        messageQueueV1Discarded: [...existingDiscarded, discardedItem].slice(-maxDiscarded),
    };
}

export function restoreMessageQueueV1DiscardedItem(
    metadata: Metadata,
    opts: { localId: string; now: number }
): Metadata {
    const existingDiscarded = metadata.messageQueueV1Discarded ?? [];
    const index = existingDiscarded.findIndex((d) => d.localId === opts.localId);
    if (index < 0) return metadata;

    const discardedItem = existingDiscarded[index];
    const nextDiscarded = [...existingDiscarded.slice(0, index), ...existingDiscarded.slice(index + 1)];

    const mq = ensureQueue(metadata);
    const restoredItem: MessageQueueV1Item = {
        localId: discardedItem.localId,
        message: discardedItem.message,
        createdAt: discardedItem.createdAt,
        updatedAt: opts.now,
    };

    const existingQueueIndex = mq.queue.findIndex((q) => q.localId === opts.localId);
    const nextQueue =
        existingQueueIndex >= 0
            ? [...mq.queue.slice(0, existingQueueIndex), restoredItem, ...mq.queue.slice(existingQueueIndex + 1)]
            : [...mq.queue, restoredItem];

    return {
        ...metadata,
        messageQueueV1: {
            ...mq,
            v: 1,
            queue: nextQueue,
        },
        messageQueueV1Discarded: nextDiscarded,
    };
}

export function deleteMessageQueueV1DiscardedItem(metadata: Metadata, localId: string): Metadata {
    const existingDiscarded = metadata.messageQueueV1Discarded ?? [];
    const nextDiscarded = existingDiscarded.filter((d) => d.localId !== localId);
    if (nextDiscarded.length === existingDiscarded.length) return metadata;
    return {
        ...metadata,
        messageQueueV1Discarded: nextDiscarded,
    };
}
