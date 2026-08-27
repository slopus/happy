import type {
    AgentCommunication,
    AgentQuestion,
    AgentQuestionAnswer,
    AgentState,
} from './storageTypes';

interface PendingBase {
    id: string;
    createdAt: number;
    toolUseId?: string | null;
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

/** A form joined to its transcript tool call, including completed answers. */
export interface AgentFormCommunication extends PendingAgentForm {
    status: 'pending' | 'answered' | 'cancelled';
    answers?: Record<string, AgentQuestionAnswer>;
}

/**
 * Pulls the communications the agent is currently waiting on out of agent state.
 *
 * Nothing the agent is blocked on is ever dropped. A kind this build does not
 * implement comes back as `unsupported`, and a malformed `form` with no
 * questions keeps a pending entry too — the user must always see that the
 * agent is waiting, even when all this build can offer is a dismissal.
 */
export function selectPendingCommunications(state: AgentState | null): PendingAgentCommunication[] {
    if (!state?.communications) return [];

    const pending: PendingAgentCommunication[] = [];
    for (const [id, communication] of Object.entries(state.communications)) {
        if (state.completedCommunications?.[id]) continue;
        const base: PendingBase = {
            id,
            createdAt: communication.createdAt ?? 0,
            ...(communication.toolUseId ? { toolUseId: communication.toolUseId } : {}),
        };

        if (communication.kind !== 'form') {
            pending.push({
                ...base,
                kind: 'unsupported',
                rawKind: communication.kind,
                title: communication.title ?? null,
            });
            continue;
        }

        pending.push({ ...base, kind: 'form', questions: readQuestions(communication) });
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Finds the form associated with one provider tool call. Completed forms win
 * over pending snapshots so the transcript can immediately render the answer.
 */
export function selectAgentFormCommunication(
    state: AgentState | null,
    toolUseId: string,
): AgentFormCommunication | null {
    if (!state || !toolUseId) return null;

    for (const [id, communication] of Object.entries(state.completedCommunications ?? {})) {
        if ((communication.toolUseId ?? id) !== toolUseId || communication.kind !== 'form') continue;
        const questions = readQuestions(communication);
        if (questions.length === 0) return null;
        return {
            id,
            createdAt: communication.createdAt ?? 0,
            ...(communication.toolUseId ? { toolUseId: communication.toolUseId } : {}),
            kind: 'form',
            questions,
            status: communication.status,
            ...(communication.answers ? { answers: communication.answers } : {}),
        };
    }

    for (const [id, communication] of Object.entries(state.communications ?? {})) {
        if (state.completedCommunications?.[id]) continue;
        if ((communication.toolUseId ?? id) !== toolUseId || communication.kind !== 'form') continue;
        const questions = readQuestions(communication);
        if (questions.length === 0) return null;
        return {
            id,
            createdAt: communication.createdAt ?? 0,
            ...(communication.toolUseId ? { toolUseId: communication.toolUseId } : {}),
            kind: 'form',
            questions,
            status: 'pending',
        };
    }

    return null;
}

export function canRenderAgentFormInline(communication: PendingAgentCommunication): boolean {
    return communication.kind === 'form' && communication.questions.length > 0;
}

export function shouldUseAgentQuestionFallback(communication: PendingAgentCommunication): boolean {
    return !canRenderAgentFormInline(communication);
}

/**
 * A question with no options must always accept written text — otherwise the
 * agent would block forever on an answer the user cannot give, even when the
 * producer set `allowCustom: false` by mistake. A question with options offers
 * text only when the agent asked for it, or when the recorded answer already
 * contains custom text.
 */
export function shouldOfferCustomAnswer(
    question: { options: readonly unknown[]; allowCustom?: boolean | null },
    hasSubmittedCustom: boolean,
): boolean {
    return question.options.length === 0 || question.allowCustom === true || hasSubmittedCustom;
}

function readQuestions(communication: AgentCommunication): AgentQuestion[] {
    return communication.form?.questions ?? [];
}
