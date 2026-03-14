import { describe, expect, it } from 'vitest';
import type { PendingMessage } from './storageTypes';
import {
  removePendingMessageFromQueue,
  sortPendingQueue,
  upsertPendingMessageInQueue,
} from './pendingQueue';

function pending(input: Partial<PendingMessage> & Pick<PendingMessage, 'id' | 'localId'>): PendingMessage {
  return {
    id: input.id,
    localId: input.localId,
    content: input.content ?? null,
    previewText: input.previewText ?? input.localId,
    imageCount: input.imageCount ?? 0,
    sentBy: input.sentBy ?? null,
    sentByName: input.sentByName ?? null,
    trackCliDelivery: input.trackCliDelivery ?? false,
    pinnedAt: input.pinnedAt ?? null,
    createdAt: input.createdAt ?? 0,
    updatedAt: input.updatedAt ?? input.createdAt ?? 0,
  };
}

describe('pendingQueue', () => {
  it('sortPendingQueue puts pinned first (latest pinned first), then unpinned by createdAt asc', () => {
    const queue = sortPendingQueue([
      pending({ id: 'n2', localId: 'n2', createdAt: 30 }),
      pending({ id: 'p1', localId: 'p1', pinnedAt: 100, createdAt: 20 }),
      pending({ id: 'n1', localId: 'n1', createdAt: 10 }),
      pending({ id: 'p2', localId: 'p2', pinnedAt: 200, createdAt: 40 }),
    ]);

    expect(queue.map((item) => item.id)).toEqual(['p2', 'p1', 'n1', 'n2']);
  });

  it('upsertPendingMessageInQueue updates existing item and keeps order stable', () => {
    const queue = [
      pending({ id: 'p1', localId: 'p1', pinnedAt: 100, createdAt: 20 }),
      pending({ id: 'n1', localId: 'n1', createdAt: 10 }),
      pending({ id: 'n2', localId: 'n2', createdAt: 30 }),
    ];

    const updated = upsertPendingMessageInQueue(queue, pending({
      id: 'n1',
      localId: 'n1',
      pinnedAt: 300,
      createdAt: 10,
      updatedAt: 999,
    }));

    expect(updated.map((item) => item.id)).toEqual(['n1', 'p1', 'n2']);
    expect(updated[0].updatedAt).toBe(999);
  });

  it('removePendingMessageFromQueue deletes one item and keeps relative order of others', () => {
    const queue = [
      pending({ id: 'p1', localId: 'p1', pinnedAt: 100, createdAt: 20 }),
      pending({ id: 'n1', localId: 'n1', createdAt: 10 }),
      pending({ id: 'n2', localId: 'n2', createdAt: 30 }),
    ];

    const updated = removePendingMessageFromQueue(queue, 'n1');
    expect(updated.map((item) => item.id)).toEqual(['p1', 'n2']);
  });
});
