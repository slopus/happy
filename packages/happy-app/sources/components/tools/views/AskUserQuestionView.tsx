import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

// Claude (the model) sometimes serializes the `questions` parameter — or the
// whole input — as a JSON-encoded string rather than a native array/object.
// Native Claude Code tolerates this; without this guard the view returns null
// and ToolView falls back to the generic permission UI (slopus/happy#936,
// also surfaces in slopus/happy#375 with multi-question forms).
function normalizeAskUserQuestionInput(rawInput: unknown): AskUserQuestionInput | undefined {
    let parsed: unknown = rawInput;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { return undefined; }
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    let questions: unknown = obj.questions;
    if (typeof questions === 'string') {
        try { questions = JSON.parse(questions); } catch { return undefined; }
    }
    if (!Array.isArray(questions)) return undefined;
    return { ...obj, questions: questions as AskUserQuestionInput['questions'] };
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    // Tolerate JSON-stringified shapes (see normalizeAskUserQuestionInput).
    const input = normalizeAskUserQuestionInput(tool.input);
    const questions = React.useMemo<InlineQuestion[]>(() => (
        (input?.questions ?? []).map((question, index) => ({
            ...question,
            id: `question-${index}`,
            required: true,
        }))
    ), [input?.questions]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !tool.permission?.id) return;

        const providerAnswers: Record<string, string> = {};
        questions.forEach((question, index) => {
            const originalQuestion = input?.questions?.[index];
            const selected = answers[question.id];
            if (originalQuestion && selected?.length) {
                providerAnswers[originalQuestion.question] = selected.join(', ');
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

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running'}
            submittedAnswers={tool.state === 'completed' ? {} : undefined}
            onSubmit={handleSubmit}
        />
    );
});