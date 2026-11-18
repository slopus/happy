import { expect, it, vi } from 'vitest';
import type { GoalTaskSession } from '@slopus/happy-wire';
import { readTaskCardHistory } from './taskCardHistory';
const session = (sessionId: string): GoalTaskSession => ({ sessionId, title: sessionId, directory: '/task', updatedAt: 1, executed: false });
const cursor = { sessionId: 'removed', updatedAt: 2 };
const select = (sessions: GoalTaskSession[]) => sessions.find(value => value.sessionId === 'valid');
it('finds an existing conversation after an unavailable first page', async () => {
    const read = vi.fn().mockResolvedValueOnce({ sessions: [session('removed')], nextCursor: cursor }).mockResolvedValueOnce({ sessions: [session('valid')] });
    const result = await readTaskCardHistory(read, select);
    expect(read.mock.calls).toEqual([[undefined], [cursor]]);
    expect(result.conversation?.sessionId).toBe('valid');
    expect(result.sessions.map(value => value.sessionId)).toEqual(['removed', 'valid']);
});
it('stops reading as soon as a valid conversation is found', async () => {
    const read = vi.fn().mockResolvedValue({ sessions: [session('valid')], nextCursor: cursor });
    expect((await readTaskCardHistory(read, select)).conversation?.sessionId).toBe('valid');
    expect(read).toHaveBeenCalledTimes(1);
});
it('only reports absence after all history pages are exhausted', async () => {
    const read = vi.fn().mockResolvedValueOnce({ sessions: [], nextCursor: cursor }).mockResolvedValueOnce({ sessions: [] });
    expect((await readTaskCardHistory(read, select)).conversation).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
});
it('preserves a lookup failure instead of treating it as no conversation', async () => {
    await expect(readTaskCardHistory(vi.fn().mockRejectedValue(new Error('offline')), select)).rejects.toThrow('offline');
});
it('rejects a repeated cursor instead of reading indefinitely', async () => {
    const read = vi.fn().mockResolvedValue({ sessions: [], nextCursor: cursor });
    await expect(readTaskCardHistory(read, select)).rejects.toThrow('pagination did not advance');
    expect(read).toHaveBeenCalledTimes(2);
});
