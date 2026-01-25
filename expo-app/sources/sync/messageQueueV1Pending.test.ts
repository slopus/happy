import { describe, expect, it } from 'vitest';
import { decodeMessageQueueV1ToPendingMessages, reconcilePendingMessagesFromMetadata } from './messageQueueV1Pending';

describe('decodeMessageQueueV1ToPendingMessages', () => {
    it('includes inFlight items along with queued items', async () => {
        const result = await decodeMessageQueueV1ToPendingMessages({
            messageQueueV1: {
                v: 1,
                inFlight: {
                    localId: 'inflight-1',
                    message: 'enc-inflight',
                    createdAt: 10,
                    updatedAt: 10,
                    claimedAt: 11,
                },
                queue: [
                    { localId: 'q-1', message: 'enc-q1', createdAt: 20, updatedAt: 20 },
                ],
            },
            messageQueueV1Discarded: [],
            decryptRaw: async (encrypted) => {
                if (encrypted === 'enc-inflight') return { content: { text: 'inflight msg' } };
                if (encrypted === 'enc-q1') return { content: { text: 'queued msg' } };
                throw new Error('unexpected encrypted');
            },
        });

        expect(result.pending.map((m) => m.id)).toEqual(['inflight-1', 'q-1']);
        expect(result.pending.map((m) => m.text)).toEqual(['inflight msg', 'queued msg']);
    });

    it('skips queue items that cannot be decoded into a text user message', async () => {
        const result = await decodeMessageQueueV1ToPendingMessages({
            messageQueueV1: {
                v: 1,
                inFlight: null,
                queue: [
                    { localId: 'q-1', message: 'enc-q1', createdAt: 20, updatedAt: 20 },
                ],
            },
            messageQueueV1Discarded: [],
            decryptRaw: async () => ({ content: { text: 123 } }),
        });

        expect(result.pending).toEqual([]);
    });

    it('skips items that fail to decrypt without failing the whole decode', async () => {
        const result = await decodeMessageQueueV1ToPendingMessages({
            messageQueueV1: {
                v: 1,
                inFlight: null,
                queue: [
                    { localId: 'q-1', message: 'enc-q1', createdAt: 20, updatedAt: 20 },
                ],
            },
            messageQueueV1Discarded: [
                { localId: 'd-1', message: 'enc-d1', createdAt: 30, updatedAt: 30, discardedAt: 31, discardedReason: 'manual' },
            ],
            decryptRaw: async (encrypted) => {
                throw new Error(`boom:${encrypted}`);
            },
        });

        expect(result).toEqual({ pending: [], discarded: [] });
    });
});

describe('reconcilePendingMessagesFromMetadata', () => {
    it('keeps existing pending items for localIds that exist in metadata but fail to decode', () => {
        const reconciled = reconcilePendingMessagesFromMetadata({
            messageQueueV1: {
                v: 1,
                inFlight: {
                    localId: 'inflight-1',
                    message: 'enc-inflight',
                    createdAt: 10,
                    updatedAt: 10,
                    claimedAt: 11,
                },
                queue: [
                    { localId: 'q-1', message: 'enc-q1', createdAt: 20, updatedAt: 20 },
                ],
            },
            messageQueueV1Discarded: [],
            decodedPending: [
                {
                    id: 'inflight-1',
                    localId: 'inflight-1',
                    createdAt: 10,
                    updatedAt: 10,
                    text: 'decoded inflight',
                    rawRecord: {} as any,
                },
            ],
            decodedDiscarded: [],
            existingPending: [
                {
                    id: 'q-1',
                    localId: 'q-1',
                    createdAt: 20,
                    updatedAt: 20,
                    text: 'optimistic queued',
                    rawRecord: {} as any,
                },
            ],
            existingDiscarded: [],
        });

        expect(reconciled.pending.map((m) => m.localId)).toEqual(['inflight-1', 'q-1']);
        expect(reconciled.pending.map((m) => m.text)).toEqual(['decoded inflight', 'optimistic queued']);
    });
});
