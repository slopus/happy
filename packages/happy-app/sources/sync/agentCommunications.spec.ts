import { describe, expect, it } from 'vitest';

import {
    buildAnswers,
    canSubmit,
    describeAnswer,
    isQuestionAnswered,
    canRenderAgentFormInline,
    shouldUseAgentQuestionFallback,
    selectAgentFormCommunication,
    selectPendingCommunications,
    toggleOption,
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

    it('drops a form with nothing answerable in it', () => {
        expect(selectPendingCommunications(state({
            'call-1': { kind: 'form', form: { questions: [] } },
        }))).toEqual([]);
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

    it('drops an option-less question that refuses written answers', () => {
        expect(selectPendingCommunications(state({
            'call-1': {
                kind: 'form',
                form: { questions: [question({ allowCustom: false, options: [] })] },
            },
        }))).toEqual([]);
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
    it('accepts choice forms and keeps text-only forms on the modal fallback', () => {
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
        })).toBe(false);
    });

    it('assigns choice forms to the transcript before their tool message arrives', () => {
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
        })).toBe(true);
    });
});

describe('toggleOption', () => {
    it('replaces the choice for a single-select question', () => {
        const first = toggleOption({ options: [], custom: '' }, 'Settings', false);
        expect(toggleOption(first, 'Locally', false).options).toEqual(['Locally']);
    });

    it('accumulates and clears choices for a multi-select question', () => {
        let draft = toggleOption({ options: [], custom: '' }, 'Settings', true);
        draft = toggleOption(draft, 'Locally', true);
        expect(draft.options).toEqual(['Settings', 'Locally']);
        expect(toggleOption(draft, 'Settings', true).options).toEqual(['Locally']);
    });

    it('lets a single-select choice be cleared by tapping it again', () => {
        const draft = toggleOption({ options: [], custom: '' }, 'Settings', false);
        expect(toggleOption(draft, 'Settings', false).options).toEqual([]);
    });

    it('leaves custom text untouched', () => {
        expect(toggleOption({ options: [], custom: 'mine' }, 'Settings', false).custom).toBe('mine');
    });
});

describe('isQuestionAnswered', () => {
    it('accepts a selection or written text', () => {
        expect(isQuestionAnswered(question(), { options: ['Settings'], custom: '' })).toBe(true);
        expect(isQuestionAnswered(question(), { options: [], custom: 'mine' })).toBe(true);
    });

    it('rejects an empty or whitespace-only draft', () => {
        expect(isQuestionAnswered(question(), { options: [], custom: '   ' })).toBe(false);
        expect(isQuestionAnswered(question(), undefined)).toBe(false);
    });

    it('treats an optional question as already answered', () => {
        expect(isQuestionAnswered(question({ required: false }), undefined)).toBe(true);
    });
});

describe('canSubmit', () => {
    it('requires every question to be answered', () => {
        const questions = [question(), question({ id: 'q2' })];
        expect(canSubmit(questions, { q1: { options: ['Settings'], custom: '' } })).toBe(false);
        expect(canSubmit(questions, {
            q1: { options: ['Settings'], custom: '' },
            q2: { options: [], custom: 'written' },
        })).toBe(true);
    });
});

describe('buildAnswers', () => {
    it('keeps written answers separate from offered options', () => {
        expect(buildAnswers([question({ allowCustom: true })], {
            q1: { options: ['Settings'], custom: '  something else  ' },
        })).toEqual({ q1: { options: ['Settings'], custom: 'something else' } });
    });

    it('trims a single-select question down to one option', () => {
        expect(buildAnswers([question()], {
            q1: { options: ['Settings', 'Locally'], custom: '' },
        })).toEqual({ q1: { options: ['Settings'] } });
    });

    it('keeps every option for a multi-select question', () => {
        expect(buildAnswers([question({ multiSelect: true })], {
            q1: { options: ['Settings', 'Locally'], custom: '' },
        })).toEqual({ q1: { options: ['Settings', 'Locally'] } });
    });

    it('drops questions the user left blank', () => {
        expect(buildAnswers([question()], { q1: { options: [], custom: '  ' } })).toEqual({});
    });
});

describe('describeAnswer', () => {
    it('joins options and written text', () => {
        expect(describeAnswer({ options: ['Settings'], custom: 'and more' }))
            .toBe('Settings, and more');
    });

    it('falls back to a dash when nothing was answered', () => {
        expect(describeAnswer(undefined)).toBe('—');
        expect(describeAnswer({ options: [] })).toBe('—');
    });
});
