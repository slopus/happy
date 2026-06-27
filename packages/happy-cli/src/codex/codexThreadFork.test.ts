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

describe('codexThreadFork', () => {
    it('lists text user messages from Codex turns as rewind points', () => {
        expect(listCodexRewindPoints(threadWithTurns)).toEqual([
            { itemId: 'user-1', text: 'first prompt', timestamp: 100_000 },
            { itemId: 'user-2', text: 'second prompt', timestamp: 200_000 },
            { itemId: 'user-3', text: 'third prompt', timestamp: 300_000 },
        ]);
    });

    it('forks the full Codex thread without rollback when no cut point is requested', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: { id: 'thread-forked', turns: [] } }),
            rollbackThread: vi.fn(),
            injectItems: vi.fn(),
        };

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project' });
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('forks, rolls back from the selected Codex user message, then re-injects that prompt', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: threadWithTurns }),
            rollbackThread: vi.fn().mockResolvedValue({ thread: { id: 'thread-forked', turns: threadWithTurns.turns.slice(0, 2) } }),
            injectItems: vi.fn().mockResolvedValue({}),
        };

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'user-2',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.rollbackThread).toHaveBeenCalledWith({ threadId: 'thread-forked', numTurns: 2 });
        expect(client.injectItems).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'second prompt' }],
            }],
        });
    });

    it('fails duplicate instead of silently returning a full fork when the selected Codex item is absent', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: threadWithTurns }),
            rollbackThread: vi.fn(),
            injectItems: vi.fn(),
        };

        await expect(forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'missing-user',
        })).rejects.toBeInstanceOf(CodexForkRewindPointNotFoundError);
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });
});
