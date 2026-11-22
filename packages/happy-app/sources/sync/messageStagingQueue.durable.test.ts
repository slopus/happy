import { describe, expect, it, vi } from 'vitest';
import { createMessageStagingQueue } from './messageStagingQueue';
const message = (id: string) => ({ id, sessionId: 's', text: id, modeMeta: {} });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('durable staging transitions', () => {
    it('serializes reducers against the latest committed state during concurrent enqueue', async () => {
        const persisted: string[][] = [];
        const queue = createMessageStagingQueue({ load: () => ({ messages: [], barriers: {} }),
            save: async state => { await tick(); persisted.push(state.messages.map(m => m.id)); },
            session: () => undefined, send: vi.fn(), steer: vi.fn() });
        const a = queue.enqueue(message('a')), b = queue.enqueue(message('b'));
        expect(queue.getSnapshot().messages).toHaveLength(0);
        await Promise.all([a, b]);
        expect(queue.getSnapshot().messages.map(m => m.id)).toEqual(['a', 'b']);
        expect(persisted).toEqual([['a'], ['a', 'b']]);
    });
    it('does not publish or send when durable admission fails', async () => {
        const send = vi.fn();
        const queue = createMessageStagingQueue({ load: () => ({ messages: [], barriers: {} }),
            save: async () => { throw new Error('quota'); }, session: () => ({ connected: true, state: 'idle' }), send, steer: vi.fn() });
        await expect(Promise.resolve().then(() => queue.enqueue(message('a')))).rejects.toThrow('quota');
        expect(queue.getSnapshot().messages).toHaveLength(0); expect(send).not.toHaveBeenCalled();
    });
});
