import { describe, expect, it } from 'vitest';

import {
    canRenderAgentFormInline,
    selectAgentFormCommunication,
    selectPendingCommunications,
    shouldOfferCustomAnswer,
    shouldUseAgentQuestionFallback,
} from './agentCommunications';
import type { AgentQuestion, AgentState } from './storageTypes';

function question(overrides?: Partial<AgentQuestion>): AgentQuestion {
    return {
        id: 'q1',
        header: 'Storage',
        question: 'Where should it live?',
        options: [{ label: 'Settings' }, { label: 'Locally' }],
        ...overrides,
    } as AgentQuestion;
}

function state(communications: Record<string, unknown>, completed?: Record<string, unknown>): AgentState {
    return { communications, completedCommunications: completed } as unknown as AgentState;
}

describe('selectPendingCommunications', () => {
    it('reads the questions out of a form the agent is waiting on', () => {
        const pending = selectPendingCommunications(state({
            'call-1': { kind: 'form', createdAt: 5, form: { questions: [question()] } },
        }));

        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe('call-1');
        expect(pending[0]).toMatchObject({ kind: 'form' });
        expect((pending[0] as { questions: AgentQuestion[] }).questions[0].header).toBe('Storage');
    });

    it('preserves the provider tool id used to join the form to its transcript card', () => {
        const pending = selectPendingCommunications(state({
            'communication-1': {
                kind: 'form',
                toolUseId: 'tool-call-1',
                form: { questions: [question()] },
            },
        }));

        expect(pending[0].toolUseId).toBe('tool-call-1');
    });

    it('surfaces a kind this build does not implement instead of dropping it', () => {
        expect(selectPendingCommunications(state({
            'call-1': { kind: 'file_pick', createdAt: 1, title: 'Pick a file' },
        }))).toEqual([
            { id: 'call-1', createdAt: 1, kind: 'unsupported', rawKind: 'file_pick', title: 'Pick a file' },
        ]);
    });

    it('leaves the title null when an unsupported kind carries none', () => {
        const pending = selectPendingCommunications(state({
            'call-1': { kind: 'diff_review', createdAt: 1 },
        }));
        expect(pending[0]).toMatchObject({ kind: 'unsupported', title: null });
    });

    it('skips communications that were already completed', () => {
        expect(selectPendingCommunications(state(
            { 'call-1': { kind: 'form', form: { questions: [question()] } } },
            { 'call-1': { kind: 'form', status: 'answered' } },
        ))).toEqual([]);
    });

    it('keeps a form with no questions so the user sees the agent is blocked', () => {
        const pending = selectPendingCommunications(state({
            'call-1': { kind: 'form', form: { questions: [] } },
        }));
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ kind: 'form', questions: [] });
        expect(shouldUseAgentQuestionFallback(pending[0])).toBe(true);
    });

    it('orders communications oldest first', () => {
        const pending = selectPendingCommunications(state({
            b: { kind: 'form', createdAt: 20, form: { questions: [question()] } },
            a: { kind: 'form', createdAt: 10, form: { questions: [question()] } },
        }));
        expect(pending.map(item => item.id)).toEqual(['a', 'b']);
    });

    it('keeps an option-less question when it takes a written answer', () => {
        const pending = selectPendingCommunications(state({
            'call-1': {
                kind: 'form',
                form: { questions: [question({ allowCustom: true, options: [] })] },
            },
        }));
        expect(pending).toHaveLength(1);
    });

    it('keeps an option-less question even when the producer refused written answers', () => {
        const pending = selectPendingCommunications(state({
            'call-1': {
                kind: 'form',
                form: { questions: [question({ allowCustom: false, options: [] })] },
            },
        }));
        expect(pending).toHaveLength(1);
        // The form ignores the refusal: text input is the only possible answer.
        expect(shouldOfferCustomAnswer(
            (pending[0] as { questions: AgentQuestion[] }).questions[0],
            false,
        )).toBe(true);
    });

    it('returns nothing when there is no agent state', () => {
        expect(selectPendingCommunications(null)).toEqual([]);
    });
});

describe('selectAgentFormCommunication', () => {
    it('joins a pending communication by provider tool id', () => {
        const communication = selectAgentFormCommunication(state({
            'communication-1': {
                kind: 'form',
                toolUseId: 'tool-call-1',
                form: { questions: [question()] },
            },
        }), 'tool-call-1');

        expect(communication).toMatchObject({
            id: 'communication-1',
            toolUseId: 'tool-call-1',
            kind: 'form',
            status: 'pending',
        });
    });

    it('uses the communication id as the join key for older snapshots', () => {
        expect(selectAgentFormCommunication(state({
            'tool-call-1': { kind: 'form', form: { questions: [question()] } },
        }), 'tool-call-1')).toMatchObject({ id: 'tool-call-1', status: 'pending' });
    });

    it('prefers the completed answer over the stale pending snapshot', () => {
        const communication = selectAgentFormCommunication(state(
            {
                'communication-1': {
                    kind: 'form',
                    toolUseId: 'tool-call-1',
                    form: { questions: [question()] },
                },
            },
            {
                'communication-1': {
                    kind: 'form',
                    toolUseId: 'tool-call-1',
                    form: { questions: [question()] },
                    status: 'answered',
                    answers: { q1: { options: ['Settings'] } },
                },
            },
        ), 'tool-call-1');

        expect(communication).toMatchObject({
            status: 'answered',
            answers: { q1: { options: ['Settings'] } },
        });
    });
});

describe('canRenderAgentFormInline', () => {
    it('accepts choice forms, text-only forms, and mixed forms alike', () => {
        expect(canRenderAgentFormInline({
            id: 'choice',
            createdAt: 0,
            kind: 'form',
            questions: [question()],
        })).toBe(true);

        expect(canRenderAgentFormInline({
            id: 'text',
            createdAt: 0,
            kind: 'form',
            questions: [question({ options: [], allowCustom: true })],
        })).toBe(true);
    });

    it('leaves only an unsupported kind to the fallback banner', () => {
        expect(shouldUseAgentQuestionFallback({
            id: 'choice',
            createdAt: 0,
            kind: 'form',
            questions: [question()],
        })).toBe(false);

        expect(shouldUseAgentQuestionFallback({
            id: 'text',
            createdAt: 0,
            kind: 'form',
            questions: [question({ options: [], allowCustom: true })],
        })).toBe(false);

        expect(shouldUseAgentQuestionFallback({
            id: 'unsupported',
            createdAt: 0,
            kind: 'unsupported',
            rawKind: 'file_pick',
            title: null,
        })).toBe(true);
    });
});

describe('shouldOfferCustomAnswer', () => {
    it('always offers text when a question has no options', () => {
        expect(shouldOfferCustomAnswer({ options: [], allowCustom: false }, false)).toBe(true);
        expect(shouldOfferCustomAnswer({ options: [], allowCustom: undefined }, false)).toBe(true);
    });

    it('offers text beside options only when the agent asked for it', () => {
        const options = [{ label: 'Settings' }];
        expect(shouldOfferCustomAnswer({ options, allowCustom: true }, false)).toBe(true);
        expect(shouldOfferCustomAnswer({ options, allowCustom: undefined }, false)).toBe(false);
        expect(shouldOfferCustomAnswer({ options, allowCustom: false }, false)).toBe(false);
    });

    it('keeps showing a recorded custom answer', () => {
        expect(shouldOfferCustomAnswer({ options: [{ label: 'A' }], allowCustom: false }, true)).toBe(true);
    });
});
