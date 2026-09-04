import { describe, expect, it, vi } from 'vitest';
import { groupMessagesForDisplay } from './useGroupedMessages';
import { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(id: string, createdAt: number, options: { pendingPermission?: boolean; state?: ToolCallMessage['tool']['state'] } = {}): ToolCallMessage {
    const state = options.state ?? 'completed';
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'CodexBash',
            state,
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
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

describe('useGroupedMessages', () => {
    it('returns chronological items with earlier agent work collapsed into one group', () => {
        // Input is newest-first, as sync stores it.
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
        expect(items[0]).toMatchObject({ type: 'message', id: 'user' });
        expect(items[1]).toMatchObject({ type: 'agent-work-group', id: 'work-tool-earliest' });
        expect(items[2]).toMatchObject({ type: 'message', id: 'agent-final' });
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        // Members are stored in chronological render order for flat expansion.
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'tool-earliest',
            'agent-progress',
            'tool-latest',
        ]);
    });

    it('does not mark completed agent work as running when a hidden tool is stale', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-stale-running', 4, { state: 'running' }),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);
        const group = items.find((item) => item.type === 'agent-work-group');

        expect(group).toMatchObject({
            type: 'agent-work-group',
            hasRunning: false,
            completedAt: 5,
        });
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
            'user',
            'tool-earliest',
            'agent-progress',
            'tool-latest',
            'agent-streaming',
        ]);
    });

    it('never groups adjacent tool calls outside a work group', () => {
        // A turn without a final agent text has no work group; its tools stay
        // flat instead of being folded into a run.
        const messages: Message[] = [
            toolMessage('tool-latest', 3),
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

        expect(items.map((item) => item.type)).toEqual(['message', 'message', 'message']);
        expect(items.map((item) => item.id)).toEqual([
            'user',
            'tool-earliest',
            'tool-latest',
        ]);
    });

    it('marks a work group when it contains a pending permission', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 4,
                text: 'done',
            },
            toolMessage('tool-pending', 3, { pendingPermission: true }),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupMessagesForDisplay(messages, true).find((item) => item.type === 'agent-work-group');

        expect(group).toMatchObject({
            type: 'agent-work-group',
            hasPendingPermission: true,
        });
    });

    it('excludes hidden tools from display entirely', () => {
        const hidden: ToolCallMessage = {
            ...toolMessage('tool-hidden', 3),
            tool: {
                ...toolMessage('tool-hidden', 3).tool,
                name: 'Skill',
            },
        };
        const messages: Message[] = [
            hidden,
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'hi',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);
        expect(items.map((item) => item.id)).toEqual(['user']);

        const flat = groupMessagesForDisplay(messages, false);
        expect(flat.map((item) => item.id)).toEqual(['user']);
    });

    it('passes messages through chronologically when grouping is disabled', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 3,
                text: 'done',
            },
            toolMessage('tool', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, false);

        expect(items.map((item) => item.id)).toEqual(['user', 'tool', 'agent-final']);
        expect(items.every((item) => item.type === 'message')).toBe(true);
    });
});
