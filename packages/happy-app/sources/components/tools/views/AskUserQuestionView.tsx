import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';
import { parseAskUserQuestionResultAnswers } from './parseAskUserQuestionAnswers';

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
    answers?: Record<string, string>;
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = React.useMemo<InlineQuestion[]>(() => (
        (input?.questions ?? []).map((question, index) => ({
            ...question,
            id: `question-${index}`,
            required: true,
        }))
    ), [input?.questions]);

    const completedAnswers = React.useMemo<InlineQuestionAnswers | null>(() => {
        if (tool.state !== 'completed') return null;
        const byQuestionText = input?.answers
            ?? parseAskUserQuestionResultAnswers(tool.result, (input?.questions ?? []).map(q => q.question))
            ?? {};
        const answers: InlineQuestionAnswers = {};
        questions.forEach((question, index) => {
            const originalQuestion = input?.questions?.[index];
            const raw = originalQuestion ? byQuestionText[originalQuestion.question] : undefined;
            if (typeof raw !== 'string' || raw.length === 0) return;

            const offeredLabels = new Set(question.options.map(option => option.label));
            const segments = question.multiSelect ? raw.split(', ') : [raw];
            const isExactOptionMatch = segments.every(segment => offeredLabels.has(segment));
            answers[question.id] = isExactOptionMatch
                ? { options: segments }
                : { options: [], custom: raw };
        });
        return Object.keys(answers).length > 0 ? answers : null;
    }, [input?.answers, input?.questions, questions, tool.result, tool.state]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !tool.permission?.id) return;

        const providerAnswers: Record<string, string> = {};
        questions.forEach((question, index) => {
            const originalQuestion = input?.questions?.[index];
            const answer = answers[question.id];
            const parts = answer ? [...answer.options, ...(answer.custom ? [answer.custom] : [])] : [];
            if (originalQuestion && parts.length > 0) {
                providerAnswers[originalQuestion.question] = parts.join(', ');
            }
        });

        // Claude resolves AskUserQuestion through its permission callback and
        // expects the chosen values merged into the tool input.
        await sessionAllow(
            sessionId,
            tool.permission.id,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswers },
        );
    }, [input?.questions, questions, sessionId, tool.permission?.id]);

    if (questions.length === 0) return null;

    const isDenied = tool.permission?.status === 'denied' || tool.permission?.status === 'canceled';
    const isUnrecoverable = tool.state === 'completed' && completedAnswers === null;

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running' && !isDenied}
            submittedAnswers={completedAnswers}
            disabledStatus={(isDenied || isUnrecoverable) ? 'superseded' : undefined}
            onSubmit={handleSubmit}
        />
    );
});