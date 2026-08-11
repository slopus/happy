import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { getAgentMessageForkTargets, resolveInitialForkRewindPointId } from './messageForkPoint';

describe('getAgentMessageForkTargets', () => {
    it('maps each visible agent response to the user prompt that owns its turn', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-new',
                localId: null,
                createdAt: 6,
                text: 'New response',
            },
            {
                kind: 'tool-call',
                id: 'tool-new',
                localId: null,
                createdAt: 5,
                tool: {
                    name: 'Bash',
                    state: 'completed',
                    input: {},
                    createdAt: 5,
                    startedAt: 5,
                    completedAt: 5,
                    description: null,
                },
                children: [],
            },
            {
                kind: 'user-text',
                id: 'user-new',
                localId: null,
                createdAt: 4,
                text: 'New prompt',
                codexItemId: 'codex-user-new',
            },
            {
                kind: 'agent-text',
                id: 'agent-old',
                localId: null,
                createdAt: 3,
                text: 'Old response',
            },
            {
                kind: 'agent-text',
                id: 'thinking-old',
                localId: null,
                createdAt: 2,
                text: 'Hidden reasoning',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user-old',
                localId: null,
                createdAt: 1,
                text: 'Old prompt',
                claudeUuid: 'claude-user-old',
            },
        ];

        const targets = getAgentMessageForkTargets(messages);

        expect(targets.get('agent-new')).toEqual({
            messageId: 'agent-new',
            messageText: 'New prompt',
            rewindPointId: 'codex-user-new',
        });
        expect(targets.get('agent-old')).toEqual({
            messageId: 'agent-old',
            messageText: 'Old prompt',
            rewindPointId: 'claude-user-old',
        });
        expect(targets.has('thinking-old')).toBe(false);
    });

    it('does not offer a fork target for agent text before the first user prompt', () => {
        const messages: Message[] = [{
            kind: 'agent-text',
            id: 'agent-only',
            localId: null,
            createdAt: 1,
            text: 'Startup message',
        }];

        expect(getAgentMessageForkTargets(messages).size).toBe(0);
    });

    it('does not expose an ambiguous Claude response when the owning prompt has no uuid', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-new',
                localId: null,
                createdAt: 4,
                text: 'New response',
            },
            {
                kind: 'user-text',
                id: 'user-new',
                localId: null,
                createdAt: 3,
                text: 'continue',
                claudeUuid: 'claude-user-new',
            },
            {
                kind: 'agent-text',
                id: 'agent-old',
                localId: null,
                createdAt: 2,
                text: 'Old response',
            },
            {
                kind: 'user-text',
                id: 'user-old',
                localId: null,
                createdAt: 1,
                text: 'continue',
            },
        ];

        const targets = getAgentMessageForkTargets(messages);

        expect(targets.has('agent-old')).toBe(false);
        expect(targets.get('agent-new')?.rewindPointId).toBe('claude-user-new');
    });

    it('allows Codex live responses to fall back when the item id has not arrived yet', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-live',
                localId: null,
                createdAt: 2,
                text: 'Live response',
            },
            {
                kind: 'user-text',
                id: 'user-live',
                localId: null,
                createdAt: 1,
                text: 'Live prompt',
            },
        ];

        expect(getAgentMessageForkTargets(messages, { allowMissingRewindPoint: true }).get('agent-live'))
            .toEqual({
                messageId: 'agent-live',
                messageText: 'Live prompt',
                rewindPointId: undefined,
            });
    });
});

describe('resolveInitialForkRewindPointId', () => {
    const repeatedPoints = [
        { id: 'new-point', text: 'continue' },
        { id: 'old-point', text: 'continue' },
    ];

    it('does not fall back to duplicate text when a provider id was supplied but is missing', () => {
        expect(resolveInitialForkRewindPointId(
            repeatedPoints,
            'missing-old-point',
            'continue',
            true,
        )).toBeNull();
    });

    it('only uses text fallback when the caller explicitly allows it without an id', () => {
        expect(resolveInitialForkRewindPointId(repeatedPoints, undefined, 'continue', false)).toBeNull();
        expect(resolveInitialForkRewindPointId(repeatedPoints, undefined, ' continue ', true)).toBe('new-point');
    });
});
