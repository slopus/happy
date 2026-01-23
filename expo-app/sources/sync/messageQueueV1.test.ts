import { describe, expect, it } from 'vitest';

import type { Metadata } from './storageTypes';
import { deleteMessageQueueV1DiscardedItem, deleteMessageQueueV1Item, discardMessageQueueV1All, discardMessageQueueV1Item, enqueueMessageQueueV1Item, restoreMessageQueueV1DiscardedItem, updateMessageQueueV1Item } from './messageQueueV1';

function baseMetadata(): Metadata {
    return { path: '/tmp', host: 'host' };
}

describe('messageQueueV1 helpers', () => {
    it('enqueues items and preserves existing queue order', () => {
        const m1 = enqueueMessageQueueV1Item(baseMetadata(), {
            localId: 'a',
            message: 'm1',
            createdAt: 1,
            updatedAt: 1,
        });
        const m2 = enqueueMessageQueueV1Item(m1, {
            localId: 'b',
            message: 'm2',
            createdAt: 2,
            updatedAt: 2,
        });

        expect(m2.messageQueueV1?.queue.map((q) => q.localId)).toEqual(['a', 'b']);
    });

    it('updates an existing queued item by localId', () => {
        const m1 = enqueueMessageQueueV1Item(baseMetadata(), {
            localId: 'a',
            message: 'm1',
            createdAt: 1,
            updatedAt: 1,
        });
        const m2 = updateMessageQueueV1Item(m1, {
            localId: 'a',
            message: 'm1-updated',
            createdAt: 1,
            updatedAt: 2,
        });

        expect(m2.messageQueueV1?.queue).toEqual([
            { localId: 'a', message: 'm1-updated', createdAt: 1, updatedAt: 2 },
        ]);
    });

    it('deletes an item by localId', () => {
        const m1 = enqueueMessageQueueV1Item(baseMetadata(), {
            localId: 'a',
            message: 'm1',
            createdAt: 1,
            updatedAt: 1,
        });
        const m2 = enqueueMessageQueueV1Item(m1, {
            localId: 'b',
            message: 'm2',
            createdAt: 2,
            updatedAt: 2,
        });
        const m3 = deleteMessageQueueV1Item(m2, 'a');
        expect(m3.messageQueueV1?.queue.map((q) => q.localId)).toEqual(['b']);
    });

    it('preserves inFlight when mutating queue', () => {
        const metadata: Metadata = {
            ...baseMetadata(),
            messageQueueV1: {
                v: 1,
                queue: [],
                inFlight: { localId: 'x', message: 'mx', createdAt: 1, updatedAt: 1, claimedAt: 1 },
            },
        };
        const next = enqueueMessageQueueV1Item(metadata, {
            localId: 'a',
            message: 'm1',
            createdAt: 2,
            updatedAt: 2,
        });
        expect(next.messageQueueV1?.inFlight?.localId).toBe('x');
    });

    it('moves queued + inFlight items into messageQueueV1Discarded and clears the queue', () => {
        const metadata: Metadata = {
            ...baseMetadata(),
            messageQueueV1: {
                v: 1,
                queue: [{ localId: 'a', message: 'm1', createdAt: 1, updatedAt: 1 }],
                inFlight: { localId: 'x', message: 'mx', createdAt: 2, updatedAt: 2, claimedAt: 3 },
            },
        };

        const { metadata: next, discarded } = discardMessageQueueV1All(metadata, {
            discardedAt: 10,
            discardedReason: 'switch_to_local',
        });

        expect(discarded.map((d) => d.localId)).toEqual(['x', 'a']);
        expect(next.messageQueueV1?.queue).toEqual([]);
        expect(next.messageQueueV1?.inFlight).toBe(null);
        expect(next.messageQueueV1Discarded?.map((d) => d.localId)).toEqual(['x', 'a']);
    });

    it('moves a queued item into messageQueueV1Discarded', () => {
        const metadata: Metadata = {
            ...baseMetadata(),
            messageQueueV1: {
                v: 1,
                queue: [{ localId: 'a', message: 'm1', createdAt: 1, updatedAt: 1 }],
                inFlight: null,
            },
        };

        const next = discardMessageQueueV1Item(metadata, {
            localId: 'a',
            discardedAt: 10,
            discardedReason: 'manual',
        });

        expect(next.messageQueueV1?.queue).toEqual([]);
        expect(next.messageQueueV1Discarded).toEqual([{
            localId: 'a',
            message: 'm1',
            createdAt: 1,
            updatedAt: 1,
            discardedAt: 10,
            discardedReason: 'manual',
        }]);
    });

    it('restores a discarded item back into the queue', () => {
        const metadata: Metadata = {
            ...baseMetadata(),
            messageQueueV1: { v: 1, queue: [] },
            messageQueueV1Discarded: [{
                localId: 'a',
                message: 'm1',
                createdAt: 1,
                updatedAt: 1,
                discardedAt: 5,
                discardedReason: 'switch_to_local',
            }],
        };

        const next = restoreMessageQueueV1DiscardedItem(metadata, { localId: 'a', now: 20 });
        expect(next.messageQueueV1?.queue).toEqual([{ localId: 'a', message: 'm1', createdAt: 1, updatedAt: 20 }]);
        expect(next.messageQueueV1Discarded).toEqual([]);
    });

    it('deletes a discarded item from messageQueueV1Discarded', () => {
        const metadata: Metadata = {
            ...baseMetadata(),
            messageQueueV1: { v: 1, queue: [] },
            messageQueueV1Discarded: [{
                localId: 'a',
                message: 'm1',
                createdAt: 1,
                updatedAt: 1,
                discardedAt: 5,
                discardedReason: 'switch_to_local',
            }],
        };

        const next = deleteMessageQueueV1DiscardedItem(metadata, 'a');
        expect(next.messageQueueV1Discarded).toEqual([]);
    });
});
