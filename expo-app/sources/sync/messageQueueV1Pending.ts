import type { DiscardedPendingMessage, Metadata, PendingMessage } from './storageTypes';

type DecryptRaw = (encrypted: string) => Promise<any>;

export async function decodeMessageQueueV1ToPendingMessages(opts: {
    messageQueueV1: NonNullable<Metadata['messageQueueV1']> | undefined;
    messageQueueV1Discarded: NonNullable<Metadata['messageQueueV1Discarded']> | undefined;
    decryptRaw: DecryptRaw;
}): Promise<{ pending: PendingMessage[]; discarded: DiscardedPendingMessage[] }> {
    const pending: PendingMessage[] = [];

    const queue = opts.messageQueueV1?.queue ?? [];
    const inFlight = opts.messageQueueV1?.inFlight ?? null;
    const orderedItems = [
        ...(inFlight ? [{ localId: inFlight.localId, message: inFlight.message, createdAt: inFlight.createdAt, updatedAt: inFlight.updatedAt }] : []),
        ...queue,
    ];

    for (const item of orderedItems) {
        let raw: any;
        try {
            raw = await opts.decryptRaw(item.message);
        } catch {
            continue;
        }
        const text = (raw as any)?.content?.text;
        if (typeof text !== 'string') continue;
        pending.push({
            id: item.localId,
            localId: item.localId,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            text,
            displayText: typeof (raw as any)?.meta?.displayText === 'string' ? (raw as any).meta.displayText : undefined,
            rawRecord: raw as any,
        });
    }

    const discarded: DiscardedPendingMessage[] = [];
    const discardedQueue = opts.messageQueueV1Discarded ?? [];
    for (const item of discardedQueue) {
        let raw: any;
        try {
            raw = await opts.decryptRaw(item.message);
        } catch {
            continue;
        }
        const text = (raw as any)?.content?.text;
        if (typeof text !== 'string') continue;
        discarded.push({
            id: item.localId,
            localId: item.localId,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            discardedAt: item.discardedAt,
            discardedReason: item.discardedReason,
            text,
            displayText: typeof (raw as any)?.meta?.displayText === 'string' ? (raw as any).meta.displayText : undefined,
            rawRecord: raw as any,
        });
    }

    return { pending, discarded };
}

export function reconcilePendingMessagesFromMetadata(opts: {
    messageQueueV1: NonNullable<Metadata['messageQueueV1']> | undefined;
    messageQueueV1Discarded: NonNullable<Metadata['messageQueueV1Discarded']> | undefined;
    decodedPending: PendingMessage[];
    decodedDiscarded: DiscardedPendingMessage[];
    existingPending: PendingMessage[];
    existingDiscarded: DiscardedPendingMessage[];
}): { pending: PendingMessage[]; discarded: DiscardedPendingMessage[] } {
    const orderedPendingLocalIds: string[] = [];
    const mq = opts.messageQueueV1;
    if (mq?.inFlight?.localId) {
        orderedPendingLocalIds.push(mq.inFlight.localId);
    }
    for (const item of mq?.queue ?? []) {
        if (typeof item.localId === 'string' && item.localId.length > 0) {
            orderedPendingLocalIds.push(item.localId);
        }
    }

    const decodedPendingByLocalId = new Map<string, PendingMessage>();
    for (const m of opts.decodedPending) {
        if (typeof m.localId === 'string' && m.localId.length > 0) {
            decodedPendingByLocalId.set(m.localId, m);
        }
    }

    const existingPendingByLocalId = new Map<string, PendingMessage>();
    for (const m of opts.existingPending) {
        if (typeof m.localId === 'string' && m.localId.length > 0) {
            existingPendingByLocalId.set(m.localId, m);
        }
    }

    const reconciledPending: PendingMessage[] = [];
    for (const localId of orderedPendingLocalIds) {
        const decoded = decodedPendingByLocalId.get(localId);
        if (decoded) {
            reconciledPending.push(decoded);
            continue;
        }
        const existing = existingPendingByLocalId.get(localId);
        if (existing) {
            reconciledPending.push(existing);
        }
    }

    const orderedDiscardedLocalIds: string[] = [];
    for (const item of opts.messageQueueV1Discarded ?? []) {
        if (typeof item.localId === 'string' && item.localId.length > 0) {
            orderedDiscardedLocalIds.push(item.localId);
        }
    }

    const decodedDiscardedByLocalId = new Map<string, DiscardedPendingMessage>();
    for (const m of opts.decodedDiscarded) {
        if (typeof m.localId === 'string' && m.localId.length > 0) {
            decodedDiscardedByLocalId.set(m.localId, m);
        }
    }

    const existingDiscardedByLocalId = new Map<string, DiscardedPendingMessage>();
    for (const m of opts.existingDiscarded) {
        if (typeof m.localId === 'string' && m.localId.length > 0) {
            existingDiscardedByLocalId.set(m.localId, m);
        }
    }

    const reconciledDiscarded: DiscardedPendingMessage[] = [];
    for (const localId of orderedDiscardedLocalIds) {
        const decoded = decodedDiscardedByLocalId.get(localId);
        if (decoded) {
            reconciledDiscarded.push(decoded);
            continue;
        }
        const existing = existingDiscardedByLocalId.get(localId);
        if (existing) {
            reconciledDiscarded.push(existing);
        }
    }

    return {
        pending: reconciledPending,
        discarded: reconciledDiscarded,
    };
}
