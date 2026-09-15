import { expect, it, vi } from 'vitest';
import { MessageWatch } from './messageWatch';

it('drains a notification arriving in the promise completion microtask window', async () => {
    const seen: number[] = [];
    const watch = new MessageWatch({ afterSeq: 0, onMessage: message => {
        seen.push(message.seq);
        if (message.seq === 1) queueMicrotask(() => watch.notify(2));
    } }, async afterSeq => ({ messages: afterSeq >= 2 ? [] : [{ id: `m${afterSeq + 1}`, seq: afterSeq + 1, content: {}, localId: null, createdAt: 1, updatedAt: 1 }], hasMore: false }), () => {}, () => {});
    try {
        await watch.sync();
        await vi.waitFor(() => expect(seen).toEqual([1, 2]));
    } finally { watch.unsubscribe(); }
});
