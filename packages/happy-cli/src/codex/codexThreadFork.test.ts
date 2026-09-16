import { describe, expect, it, vi } from 'vitest';

import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from './codexThreadFork';

const threadWithTurns = {
    id: 'thread-source',
    turns: [
        {
            id: 'turn-1',
            startedAt: 100,
            items: [
                { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'first prompt' }] },
                { type: 'agentMessage', id: 'agent-1', text: 'first answer' },
            ],
        },
        {
            id: 'turn-2',
            startedAt: 200,
            items: [
                { type: 'userMessage', id: 'user-2', content: [{ type: 'text', text: 'second prompt' }] },
                { type: 'agentMessage', id: 'agent-2', text: 'second answer' },
            ],
        },
        {
            id: 'turn-3',
            startedAt: 300,
            items: [
                { type: 'userMessage', id: 'user-3', content: [{ type: 'text', text: 'third prompt' }] },
                { type: 'agentMessage', id: 'agent-3', text: 'third answer' },
            ],
        },
    ],
};

function forkClient() {
    let forkTurns = threadWithTurns.turns;
    return {
        readThread: vi.fn().mockImplementation(async ({ threadId }) => ({ thread: { id: threadId, turns: threadId === 'thread-source' ? threadWithTurns.turns : forkTurns } })),
        // Modern forks need not return hydrated turns.
        forkThread: vi.fn().mockImplementation(async (opts) => {
            const boundary = opts.lastTurnId ?? opts.beforeTurnId;
            forkTurns = boundary ? threadWithTurns.turns.slice(0, threadWithTurns.turns.findIndex(t => t.id === boundary) + (opts.lastTurnId ? 1 : 0)) : threadWithTurns.turns;
            return { threadId: 'thread-forked', thread: { id: 'thread-forked', turns: [] } };
        }),
        rollbackThread: vi.fn().mockRejectedValue(new Error('paginated threads do not support thread/rollback')),
        injectItems: vi.fn().mockResolvedValue({}),
        deleteThread: vi.fn().mockResolvedValue({}),
    };
}

describe('codexThreadFork', () => {
    it('lists text user messages from Codex turns as rewind points', () => {
        expect(listCodexRewindPoints(threadWithTurns)).toEqual([
            { itemId: 'user-1', text: 'first prompt', timestamp: 100_000 },
            { itemId: 'user-2', text: 'second prompt', timestamp: 200_000 },
            { itemId: 'user-3', text: 'third prompt', timestamp: 300_000 },
        ]);
    });

    it('forks the full Codex thread without rollback when no cut point is requested', async () => {
        const client = forkClient();

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project' });
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
        expect(client.readThread).not.toHaveBeenCalled();
    });

    it('excludes the boundary question and all later content without reinjecting it', async () => {
        const client = forkClient();
        await forkCodexThread(client, { threadId: 'thread-source', cutBeforeItemId: 'user-2' });
        const { thread } = await client.readThread({ threadId: 'thread-forked', includeTurns: true });
        expect(thread.turns).toEqual([threadWithTurns.turns[0]]);
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('does not silently remove earlier messages when the excluded question is inside a turn', async () => {
        const client = forkClient();
        client.readThread.mockResolvedValueOnce({ thread: { id: 'thread-source', turns: [{
            ...threadWithTurns.turns[0],
            items: [...threadWithTurns.turns[0].items, ...threadWithTurns.turns[1].items],
        }] } });
        await expect(forkCodexThread(client, { threadId: 'thread-source', cutBeforeItemId: 'user-2' }))
            .rejects.toThrow('inside a Codex turn');
        expect(client.forkThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('forks before the selected user turn and restores its prompt without rollback', async () => {
        const client = forkClient();

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'user-2',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project', beforeTurnId: 'turn-2', deferGoalContinuation: true });
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'second prompt' }],
            }],
        });
    });

    it('retains the selected complete turn when forking from an agent response', async () => {
        const client = forkClient();

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'user-2',
            retainSelectedTurn: true,
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project', lastTurnId: 'turn-2', deferGoalContinuation: true });
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('fails duplicate instead of silently returning a full fork when the selected Codex item is absent', async () => {
        const client = forkClient();

        await expect(forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'missing-user',
        })).rejects.toBeInstanceOf(CodexForkRewindPointNotFoundError);
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
        expect(client.forkThread).not.toHaveBeenCalled();
    });

    it.each(['user-1', 'user-3'])('supports boundary user turn %s', async (itemId) => {
        const client = forkClient();
        await forkCodexThread(client, { threadId: 'thread-source', cutAfterItemId: itemId });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', beforeTurnId: itemId.replace('user', 'turn'), deferGoalContinuation: true });
        expect(client.rollbackThread).not.toHaveBeenCalled();
    });

    it('propagates unsupported boundary errors instead of silently keeping later history', async () => {
        const client = forkClient();
        client.forkThread.mockRejectedValue(new Error('unsupported boundary'));
        await expect(forkCodexThread(client, { threadId: 'thread-source', cutAfterItemId: 'user-2' })).rejects.toThrow('unsupported boundary');
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('rejects and deletes a full fork when an older server ignores the boundary', async () => {
        const client = forkClient();
        client.forkThread.mockResolvedValue({ threadId: 'thread-forked', thread: { id: 'thread-forked', turns: [] } });
        await expect(forkCodexThread(client, { threadId: 'thread-source', cutAfterItemId: 'user-2' })).rejects.toThrow('requested fork boundary');
        expect(client.injectItems).not.toHaveBeenCalled();
        expect(client.deleteThread).toHaveBeenCalledWith({ threadId: 'thread-forked' });
    });

    it('cleans up only the new fork if prompt restoration fails, preserving the original error', async () => {
        const client = forkClient();
        client.injectItems.mockRejectedValue(new Error('injection failed'));
        client.deleteThread.mockRejectedValue(new Error('cleanup failed'));
        await expect(forkCodexThread(client, { threadId: 'thread-source', cutAfterItemId: 'user-1' })).rejects.toThrow('injection failed');
        expect(client.deleteThread).toHaveBeenCalledWith({ threadId: 'thread-forked' });
    });
});
