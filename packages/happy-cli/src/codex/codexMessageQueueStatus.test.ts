import { describe, expect, it } from 'vitest';
import type { AgentState } from '@/api/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { applyPersistedTurnStatus } from '@/api/sessionTurnStatus';
import { createCodexMessageQueueStatus } from './codexMessageQueueStatus';

function setup(initial: AgentState = {}) {
    let state = initial;
    let writes = Promise.resolve();
    const observed: AgentState[] = [];
    const session = {
        updateAgentState(update: (state: AgentState) => AgentState) {
            // Match ApiSessionClient's serialized asynchronous state writes.
            writes = writes.then(() => { state = update(state); observed.push(state); });
            return writes;
        },
    };
    const queue = new MessageQueue2<string>(mode => mode);
    const status = createCodexMessageQueueStatus(() => queue.size(), () => session);
    return { queue, status, session, observed, state: () => state };
}

describe('Codex message queue handoff', () => {
    it.each([undefined, 'previous-turn'])('stays busy before native turn-start (previous: %s)', async previous => {
        const t = setup(previous ? { turnStatus: { status: 'completed', turnId: previous, updatedAt: 1 } } : {});
        t.queue.push('1', 'mode');
        await t.status.sync();
        expect((await t.queue.waitForMessagesAndGetAsString())?.message).toBe('1');
        await t.status.begin();
        // thread/start, attachment work or turn/start can take arbitrarily long.
        await t.status.sync();
        expect(t.observed.every(s => (s.queuedMessages ?? 0) > 0)).toBe(true);

        const start = t.session.updateAgentState(s => applyPersistedTurnStatus(s, {
            status: 'running', turnId: 'new-turn', updatedAt: 2,
        }));
        const released = t.status.release();
        await Promise.all([start, released]);
        expect(t.state().queuedMessages).toBeUndefined();
        expect(t.observed.every(s => (s.queuedMessages ?? 0) > 0 || s.turnStatus?.status === 'running')).toBe(true);
    });

    it('retains later inputs and releases a failed startup without a phantom queue', async () => {
        const t = setup();
        t.queue.push('1', 'mode');
        await t.status.sync();
        await t.queue.waitForMessagesAndGetAsString();
        await t.status.begin();
        t.queue.push('2', 'mode');
        await t.status.sync();
        expect(t.state().queuedMessages).toBe(2);
        await t.status.release(); // failed/cancelled before native task_started
        expect(t.state().queuedMessages).toBe(1);
        expect((await t.queue.waitForMessagesAndGetAsString())?.message).toBe('2');
        await t.status.begin();
        await t.status.release();
        expect(t.state().queuedMessages).toBeUndefined();
    });

    it('finishes an immediate slash command while preserving its completed lifecycle', async () => {
        const t = setup();
        t.queue.push('/status', 'mode');
        await t.status.sync();
        await t.queue.waitForMessagesAndGetAsString();
        await t.status.begin();
        await t.session.updateAgentState(s => applyPersistedTurnStatus(s, {
            status: 'completed', turnId: 'local-command', updatedAt: 2,
        }));
        await t.status.release();
        expect(t.state()).toEqual({ turnStatus: { status: 'completed', turnId: 'local-command', updatedAt: 2 } });
    });
});
