import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    buildDirectMessageForkOptions,
    getAgentMessageForkTargets,
    getUserMessageForkRewindPointId,
    resolveInitialForkRewindPointId,
} from './messageForkPoint';

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
                codexItemId: 'codex-user-old',
            },
        ];

        const targets = getAgentMessageForkTargets(messages, { flavor: 'codex' });

        expect(targets.get('agent-new')).toEqual({
            messageId: 'agent-new',
            messageText: 'New prompt',
            rewindPointId: 'codex-user-new',
        });
        expect(targets.get('agent-old')).toEqual({
            messageId: 'agent-old',
            messageText: 'Old prompt',
            rewindPointId: 'codex-user-old',
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

        const targets = getAgentMessageForkTargets(messages, { flavor: 'claude' });

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

        expect(getAgentMessageForkTargets(messages, {
            flavor: 'codex',
            allowMissingRewindPoint: true,
        }).get('agent-live'))
            .toEqual({
                messageId: 'agent-live',
                messageText: 'Live prompt',
                rewindPointId: undefined,
            });
    });

    it('uses only the provider id for the active session flavor', () => {
        const message = {
            claudeUuid: 'claude-turn',
            codexItemId: 'codex-turn',
        };

        expect(getUserMessageForkRewindPointId(message, 'codex')).toBe('codex-turn');
        expect(getUserMessageForkRewindPointId(message, 'claude')).toBe('claude-turn');
        expect(getUserMessageForkRewindPointId({ claudeUuid: 'claude-only' }, 'codex')).toBeUndefined();
        expect(getUserMessageForkRewindPointId({ codexItemId: 'codex-only' }, 'claude')).toBeUndefined();
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

describe('buildDirectMessageForkOptions', () => {
    it('forks a Codex agent response from its owning turn without another selection step', () => {
        expect(buildDirectMessageForkOptions('codex', {
            messageId: 'agent-turn-2',
            rewindPointId: 'codex-user-turn-2',
            retainSelectedTurn: true,
        })).toEqual({
            cutAfterItemId: 'codex-user-turn-2',
            forkedFromMessageId: 'agent-turn-2',
            retainSelectedTurn: true,
        });
    });

    it('does not guess a turn when the provider rewind id is unavailable', () => {
        expect(buildDirectMessageForkOptions('codex', {
            messageId: 'agent-turn-2',
            rewindPointId: undefined,
            retainSelectedTurn: true,
        })).toBeNull();
    });

    it('uses the owning Claude turn id directly', () => {
        expect(buildDirectMessageForkOptions('claude', {
            messageId: 'agent-turn-2',
            rewindPointId: 'claude-user-turn-2',
            retainSelectedTurn: true,
        })).toEqual({
            cutAfterUuid: 'claude-user-turn-2',
            forkedFromMessageId: 'agent-turn-2',
        });
    });
});
