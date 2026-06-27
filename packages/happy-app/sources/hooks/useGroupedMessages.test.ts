import { describe, expect, it, vi } from 'vitest';
import { groupMessagesForDisplay, groupToolCallsForDisplay } from './useGroupedMessages';
import { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(id: string, createdAt: number, options: { pendingPermission?: boolean } = {}): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'CodexBash',
            state: 'completed',
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
            ...(options.pendingPermission
                ? {
                    permission: {
                        id: `permission-${id}`,
                        status: 'pending' as const,
                    },
                }
                : {}),
        },
        children: [],
    };
}

function namedToolMessage(id: string, name: string, createdAt: number): ToolCallMessage {
    const message = toolMessage(id, createdAt);
    return {
        ...message,
        tool: {
            ...message.tool,
            name,
        },
    };
}

describe('useGroupedMessages', () => {
    it('stores grouped tools in chronological render order', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-after-tools',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-middle', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupToolCallsForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group?.messages.map((message) => message.id)).toEqual([
            'tool-earliest',
            'tool-middle',
            'tool-latest',
        ]);
    });

    it('groups only adjacent tool calls between text messages', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 7,
                text: 'done',
            },
            toolMessage('tool-4', 6),
            toolMessage('tool-3', 5),
            {
                kind: 'agent-text',
                id: 'agent-middle',
                localId: null,
                createdAt: 4,
                text: 'next step',
            },
            toolMessage('tool-2', 3),
            toolMessage('tool-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const groups = groupToolCallsForDisplay(messages, true).filter((item) => item.type === 'tool-group');

        expect(groups).toHaveLength(2);
        expect(groups[0]?.messages.map((message) => message.id)).toEqual(['tool-3', 'tool-4']);
        expect(groups[1]?.messages.map((message) => message.id)).toEqual(['tool-1', 'tool-2']);
    });

    it('keeps the final agent message visible and collapses earlier agent work', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'agent-final' });
        expect(items[1]).toMatchObject({ type: 'agent-work-group', id: 'work-tool-earliest' });
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'tool-latest',
            'agent-progress',
            'tool-earliest',
        ]);
    });

    it('does not collapse the current turn while the agent is still working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual([
            'message',
            'message',
            'message',
            'message',
            'message',
        ]);
        expect(items.map((item) => item.id)).toEqual([
            'agent-streaming',
            'tool-latest',
            'agent-progress',
            'tool-earliest',
            'user',
        ]);
    });

    it('still groups adjacent current-turn tools while the agent is working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-earliest', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['message', 'tool-group', 'message']);
        expect(items[1]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: false,
        });
    });

    it('marks a tool group when it contains a pending permission', () => {
        const messages: Message[] = [
            toolMessage('tool-latest', 3, { pendingPermission: true }),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupMessagesForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: true,
        });
    });

    it('does not collapse a single standalone tool call into a tool group', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'tool-only' });
    });

    it('hides Claude Skill tool calls from the display list', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 3,
                text: 'done',
            },
            namedToolMessage('skill-tool', 'Skill', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run skill',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.id)).toEqual(['agent-final', 'user']);
    });

    it('keeps an <options> block visible instead of folding it into the work group', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 4,
                text: 'done',
            },
            {
                kind: 'agent-text',
                id: 'agent-options',
                localId: null,
                createdAt: 3,
                text: 'Pick one:\n<options>\n    <option>A</option>\n    <option>B</option>\n</options>',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        // The options message renders standalone; only the older tool folds.
        expect(items.map((item) => ({ type: item.type, id: item.id }))).toEqual([
            { type: 'message', id: 'agent-final' },
            { type: 'message', id: 'agent-options' },
            { type: 'agent-work-group', id: 'work-tool-earliest' },
            { type: 'message', id: 'user' },
        ]);
        const workGroup = items.find((item) => item.type === 'agent-work-group');
        if (workGroup?.type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(workGroup.messages.map((message) => message.id)).toEqual([
            'tool-earliest',
        ]);
    });

    it('splits the fold around an interleaved selection so chronology is preserved', () => {
        // Chronological: user → tool-old → <options> → tool-new → final.
        // The selection card must render BETWEEN the two work groups, not be
        // pushed to one side of a single merged group.
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-new', 4),
            {
                kind: 'agent-text',
                id: 'agent-options',
                localId: null,
                createdAt: 3,
                text: '<options>\n    <option>A</option>\n</options>',
            },
            toolMessage('tool-old', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => ({ type: item.type, id: item.id }))).toEqual([
            { type: 'message', id: 'agent-final' },
            { type: 'agent-work-group', id: 'work-tool-new' },
            { type: 'message', id: 'agent-options' },
            { type: 'agent-work-group', id: 'work-tool-old' },
            { type: 'message', id: 'user' },
        ]);
    });

    it('does not treat an inline "<options>" mention in prose as a selection block', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 4,
                text: 'done',
            },
            {
                kind: 'agent-text',
                id: 'agent-mentions-options',
                localId: null,
                createdAt: 3,
                text: 'I parsed the `<options>` tag in the code.',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'explain',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        // The prose mention is ordinary agent work and still folds.
        const workGroup = items.find((item) => item.type === 'agent-work-group');
        if (workGroup?.type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(workGroup.messages.map((message) => message.id)).toEqual([
            'agent-mentions-options',
            'tool-earliest',
        ]);
    });

    it('keeps an AskUserQuestion card visible instead of folding it into the work group', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            namedToolMessage('ask', 'AskUserQuestion', 4),
            {
                kind: 'agent-text',
                id: 'agent-intro',
                localId: null,
                createdAt: 3,
                text: 'one question',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'go',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => ({ type: item.type, id: item.id }))).toEqual([
            { type: 'message', id: 'agent-final' },
            { type: 'message', id: 'ask' },
            { type: 'agent-work-group', id: 'work-tool-earliest' },
            { type: 'message', id: 'user' },
        ]);
    });

    it('does not bury a waiting AskUserQuestion inside a collapsed tool group', () => {
        const messages: Message[] = [
            namedToolMessage('ask', 'AskUserQuestion', 4),
            toolMessage('tool-b', 3),
            toolMessage('tool-a', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'go',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        // The preceding tools fold; the question stands alone and tappable.
        expect(items.map((item) => ({ type: item.type, id: item.id }))).toEqual([
            { type: 'message', id: 'ask' },
            { type: 'tool-group', id: 'group-tool-a' },
            { type: 'message', id: 'user' },
        ]);
    });

    it('can collapse single standalone tool calls for nested work details', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupToolCallsForDisplay(messages, true, { groupSingleToolCalls: true });

        expect(items.map((item) => item.type)).toEqual(['tool-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-only',
            hasPendingPermission: false,
        });
        if (items[0].type !== 'tool-group') {
            throw new Error('Expected a tool group');
        }
        expect(items[0].messages.map((message) => message.id)).toEqual(['tool-only']);
    });
});
