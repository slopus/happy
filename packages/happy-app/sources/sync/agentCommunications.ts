import type {
    AgentCommunication,
    AgentQuestion,
    AgentQuestionAnswer,
    AgentState,
} from './storageTypes';

interface PendingBase {
    id: string;
    createdAt: number;
}

/** A communication this build knows how to render and answer. */
export interface PendingAgentForm extends PendingBase {
    kind: 'form';
    questions: AgentQuestion[];
}

/**
 * A communication whose `kind` this build does not implement. It is still
 * surfaced so the user can see that the agent is blocked and dismiss it,
 * instead of the request vanishing while the agent waits on an answer that
 * will never arrive.
 */
export interface PendingUnsupportedCommunication extends PendingBase {
    kind: 'unsupported';
    rawKind: string;
    title: string | null;
}

export type PendingAgentCommunication = PendingAgentForm | PendingUnsupportedCommunication;

/** A draft answer while the user is filling the form in. */
export interface AgentQuestionDraft {
    options: string[];
    custom: string;
}

export const EMPTY_DRAFT: AgentQuestionDraft = { options: [], custom: '' };

/**
 * Pulls the communications the agent is currently waiting on out of agent state.
 *
 * A kind this build does not implement comes back as `unsupported` rather than
 * being dropped, so the UI can say so plainly. A `form` that carries nothing
 * answerable is dropped, since there would be nothing to show.
 */
export function selectPendingCommunications(state: AgentState | null): PendingAgentCommunication[] {
    if (!state?.communications) return [];

    const pending: PendingAgentCommunication[] = [];
    for (const [id, communication] of Object.entries(state.communications)) {
        if (state.completedCommunications?.[id]) continue;
        const base = { id, createdAt: communication.createdAt ?? 0 };

        if (communication.kind !== 'form') {
            pending.push({
                ...base,
                kind: 'unsupported',
                rawKind: communication.kind,
                title: communication.title ?? null,
            });
            continue;
        }

        const questions = readQuestions(communication);
        if (questions.length === 0) continue;
        pending.push({ ...base, kind: 'form', questions });
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
}

/** A question is answerable if it offers options or accepts written text. */
function readQuestions(communication: AgentCommunication): AgentQuestion[] {
    return (communication.form?.questions ?? []).filter(
        question => question.options.length > 0 || question.allowCustom !== false,
    );
}

/**
 * Applies a tap on an option. Single-select questions replace the selection so
 * tapping a second option moves the choice; multi-select toggles it, which also
 * lets the user clear a choice they made by mistake.
 */
export function toggleOption(
    draft: AgentQuestionDraft,
    label: string,
    multiSelect: boolean,
): AgentQuestionDraft {
    if (!multiSelect) {
        return { ...draft, options: draft.options.includes(label) ? [] : [label] };
    }
    return {
        ...draft,
        options: draft.options.includes(label)
            ? draft.options.filter(option => option !== label)
            : [...draft.options, label],
    };
}

/** A question counts as answered once it has a selection or custom text. */
export function isQuestionAnswered(
    question: AgentQuestion,
    draft: AgentQuestionDraft | undefined,
): boolean {
    if (question.required === false) return true;
    if (!draft) return false;
    return draft.options.length > 0 || draft.custom.trim().length > 0;
}

export function canSubmit(
    questions: AgentQuestion[],
    drafts: Record<string, AgentQuestionDraft>,
): boolean {
    return questions.every(question => isQuestionAnswered(question, drafts[question.id]));
}

/**
 * Freezes the drafts into the answer payload sent back to the agent. Custom text
 * stays in its own field so the agent can tell a written answer apart from one
 * it offered, and blank drafts are dropped rather than sent as empty answers.
 */
export function buildAnswers(
    questions: AgentQuestion[],
    drafts: Record<string, AgentQuestionDraft>,
): Record<string, AgentQuestionAnswer> {
    const answers: Record<string, AgentQuestionAnswer> = {};
    for (const question of questions) {
        const draft = drafts[question.id];
        if (!draft) continue;
        const custom = draft.custom.trim();
        const options = question.multiSelect ? draft.options : draft.options.slice(0, 1);
        if (options.length === 0 && custom.length === 0) continue;
        answers[question.id] = {
            options,
            ...(custom.length > 0 ? { custom } : {}),
        };
    }
    return answers;
}

/** One-line summary of an answer, for the collapsed card. */
export function describeAnswer(answer: AgentQuestionAnswer | undefined): string {
    if (!answer) return '—';
    const parts = [...answer.options];
    if (answer.custom) parts.push(answer.custom);
    return parts.length > 0 ? parts.join(', ') : '—';
}
