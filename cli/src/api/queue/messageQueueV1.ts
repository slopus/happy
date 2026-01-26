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

const MESSAGE_QUEUE_V1_RECLAIM_IN_FLIGHT_AFTER_MS = 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseQueueItem(raw: unknown): MessageQueueV1Item | null {
    if (!isPlainObject(raw)) return null;
    const localId = raw.localId;
    const message = raw.message;
    const createdAt = raw.createdAt;
    const updatedAt = raw.updatedAt;
    if (typeof localId !== 'string') return null;
    if (typeof message !== 'string') return null;
    if (typeof createdAt !== 'number') return null;
    if (typeof updatedAt !== 'number') return null;
    return { localId, message, createdAt, updatedAt };
}

function parseInFlight(raw: unknown): MessageQueueV1InFlight | null {
    if (!isPlainObject(raw)) return null;
    const claimedAt = raw.claimedAt;
    const item = parseQueueItem(raw);
    if (!item) return null;
    if (typeof claimedAt !== 'number') return null;
    return { ...item, claimedAt };
}

function parseDiscardedItem(raw: unknown): MessageQueueV1DiscardedItem | null {
    if (!isPlainObject(raw)) return null;
    const item = parseQueueItem(raw);
    if (!item) return null;
    const discardedAt = (raw as any).discardedAt;
    const discardedReason = (raw as any).discardedReason;
    if (typeof discardedAt !== 'number') return null;
    if (discardedReason !== 'switch_to_local' && discardedReason !== 'manual') return null;
    return { ...item, discardedAt, discardedReason };
}

export function parseMessageQueueV1(raw: unknown): MessageQueueV1 | null {
    if (!isPlainObject(raw)) return null;
    if (raw.v !== 1) return null;
    const queueRaw = raw.queue;
    if (!Array.isArray(queueRaw)) return null;
    const queue: MessageQueueV1Item[] = [];
    for (const entry of queueRaw) {
        const parsed = parseQueueItem(entry);
        if (!parsed) return null;
        queue.push(parsed);
    }

    const inFlightRaw = (raw as any).inFlight;
    let inFlight: MessageQueueV1InFlight | null | undefined;
    if (inFlightRaw === undefined) {
        inFlight = undefined;
    } else if (inFlightRaw === null) {
        inFlight = null;
    } else {
        const parsed = parseInFlight(inFlightRaw);
        if (!parsed) return null;
        inFlight = parsed;
    }

    return {
        v: 1,
        queue,
        ...(inFlightRaw !== undefined ? { inFlight: inFlight ?? null } : {}),
    };
}

function parseDiscardedList(raw: unknown): MessageQueueV1DiscardedItem[] | null {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return null;
    const result: MessageQueueV1DiscardedItem[] = [];
    for (const entry of raw) {
        const parsed = parseDiscardedItem(entry);
        if (!parsed) return null;
        result.push(parsed);
    }
    return result;
}

export function claimMessageQueueV1Next(metadata: Record<string, unknown>, now: number): { metadata: Record<string, unknown>; inFlight: MessageQueueV1InFlight } | null {
    const mqRaw = (metadata as any).messageQueueV1;
    const mq = parseMessageQueueV1(mqRaw);
    if (!mq) return null;

    if (mq.inFlight) {
        const ageMs = now - mq.inFlight.claimedAt;
        if (ageMs < MESSAGE_QUEUE_V1_RECLAIM_IN_FLIGHT_AFTER_MS) {
            return { metadata, inFlight: mq.inFlight };
        }

        // If the inFlight claim is stale (agent crash or missed acknowledgement),
        // move it back to the front of the queue and re-claim it with a fresh claimedAt.
        const { claimedAt: _claimedAt, ...item } = mq.inFlight;
        const recoveredQueue = [item, ...mq.queue];
        const inFlight: MessageQueueV1InFlight = { ...item, claimedAt: now };
        const nextMq: MessageQueueV1 = {
            ...mq,
            queue: recoveredQueue.slice(1),
            inFlight,
        };

        return {
            metadata: {
                ...metadata,
                messageQueueV1: nextMq,
            },
            inFlight,
        };
    }

    const first = mq.queue[0];
    if (!first) return null;

    const inFlight: MessageQueueV1InFlight = { ...first, claimedAt: now };
    const nextMq: MessageQueueV1 = {
        ...mq,
        queue: mq.queue.slice(1),
        inFlight,
    };

    return {
        metadata: {
            ...metadata,
            messageQueueV1: nextMq,
        },
        inFlight,
    };
}

export function clearMessageQueueV1InFlight(metadata: Record<string, unknown>, localId: string): Record<string, unknown> {
    const mqRaw = (metadata as any).messageQueueV1;
    const mq = parseMessageQueueV1(mqRaw);
    if (!mq?.inFlight) return metadata;
    if (mq.inFlight.localId !== localId) return metadata;
    return {
        ...metadata,
        messageQueueV1: {
            ...mq,
            inFlight: null,
        },
    };
}

export function discardMessageQueueV1All(metadata: Record<string, unknown>, opts: { now: number; reason: MessageQueueV1DiscardedReason; maxDiscarded?: number }): { metadata: Record<string, unknown>; discarded: MessageQueueV1DiscardedItem[] } | null {
    const mqRaw = (metadata as any).messageQueueV1;
    const mq = parseMessageQueueV1(mqRaw);
    if (!mq) return null;

    const toDiscard: MessageQueueV1Item[] = [];
    if (mq.inFlight) {
        const { claimedAt: _claimedAt, ...rest } = mq.inFlight;
        toDiscard.push(rest);
    }
    for (const item of mq.queue) {
        toDiscard.push(item);
    }
    if (toDiscard.length === 0) {
        return { metadata, discarded: [] };
    }

    const existingDiscarded = parseDiscardedList((metadata as any).messageQueueV1Discarded) ?? [];
    const discarded = toDiscard.map((item) => ({
        ...item,
        discardedAt: opts.now,
        discardedReason: opts.reason,
    }));
    const maxDiscarded = opts.maxDiscarded ?? 50;
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
