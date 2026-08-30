import * as React from 'react';

import { sessionAnswerQuestion } from '@/sync/ops';
import { useSessionAgentFormCommunication } from '@/sync/storage';
import type { AgentQuestionAnswer } from '@/sync/storageTypes';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';

/** Inline renderer for Happy/Codex request_user_input communications. */
export const RequestUserInputView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');

    const submittedAnswers = React.useMemo<InlineQuestionAnswers | null>(() => {
        if (!communication || communication.status === 'pending') return null;
        if (communication.status === 'cancelled' || !communication.answers) return {};
        const answers: InlineQuestionAnswers = {};
        for (const [questionId, answer] of Object.entries(communication.answers)) {
            const values = [...answer.options];
            if (answer.custom) values.push(answer.custom);
            answers[questionId] = values;
        }
        return answers;
    }, [communication]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !communication || communication.status !== 'pending') return;

        const communicationAnswers: Record<string, AgentQuestionAnswer> = {};
        for (const question of communication.questions) {
            const selected = answers[question.id];
            if (!selected?.length) continue;
            communicationAnswers[question.id] = {
                options: question.multiSelect
                    ? selected
                    : selected.slice(0, 1),
            };
        }
        await sessionAnswerQuestion(sessionId, communication.id, communicationAnswers, communication.kind);
    }, [communication, sessionId]);

    if (!communication || communication.questions.some(question => question.options.length === 0)) {
        return null;
    }

    return (
        <InlineQuestionForm
            questions={communication.questions}
            canInteract={tool.state === 'running' && communication.status === 'pending'}
            submittedAnswers={submittedAnswers}
            onSubmit={handleSubmit}
        />
    );
});