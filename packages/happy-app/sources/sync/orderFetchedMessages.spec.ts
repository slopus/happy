import { describe, it, expect } from 'vitest';
import { NormalizedMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { orderFetchedMessages } from './orderFetchedMessages';

// An Agent tool call and two messages from its subagent, in session order.
function agentWithSubagent(): Array<{ seq: number; message: NormalizedMessage }> {
    return [
        {
            seq: 1,
            message: {
                id: 'agent-parent-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-agent-parent',
                    name: 'Agent',
                    input: {
                        description: 'Look something up',
                        prompt: 'Look something up',
                        sessionSubagent: 'session-subagent-1',
                    },
                    description: 'Look something up',
                    uuid: 'agent-parent-uuid',
                    parentUUID: null
                }]
            },
        },
        {
            seq: 2,
            message: {
                id: 'agent-child-search',
                localId: null,
                createdAt: 1100,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'tool-call',
                    id: 'tool-search-child',
                    name: 'WebSearch',
                    input: { query: 'example' },
                    description: null,
                    uuid: 'agent-child-search-uuid',
                    parentUUID: 'session-subagent-1'
                }]
            },
        },
        {
            seq: 3,
            message: {
                id: 'agent-child-fetch',
                localId: null,
                createdAt: 1200,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'tool-call',
                    id: 'tool-fetch-child',
                    name: 'WebFetch',
                    input: { url: 'https://example.com' },
                    description: null,
                    uuid: 'agent-child-fetch-uuid',
                    parentUUID: 'session-subagent-1'
                }]
            },
        },
    ];
}

describe('orderFetchedMessages', () => {
    it('orders a newest-first page by seq', () => {
        const page = [{ seq: 3 }, { seq: 1 }, { seq: 2 }];
        expect(orderFetchedMessages(page).map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(page.map((m) => m.seq)).toEqual([3, 1, 2]);
    });

    it('keeps subagent messages nested under their Agent call for a newest-first page', () => {
        // What a `before_seq` history fetch returns.
        const newestFirst = agentWithSubagent().reverse();

        const result = reducer(
            createReducer(),
            orderFetchedMessages(newestFirst).map((m) => m.message),
        );

        expect(result.messages).toHaveLength(1);
        const agent = result.messages[0];
        expect(agent.kind).toBe('tool-call');
        if (agent.kind === 'tool-call') {
            expect(agent.tool.name).toBe('Agent');
            expect(agent.children.map((c) => c.kind === 'tool-call' ? c.tool.name : c.kind))
                .toEqual(['WebSearch', 'WebFetch']);
        }
    });
});
