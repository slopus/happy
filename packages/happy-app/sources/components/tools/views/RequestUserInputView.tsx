import * as React from 'react';

import { sessionAnswerQuestion } from '@/sync/ops';
import { useSessionAgentFormCommunication } from '@/sync/storage';
import type { AgentQuestionAnswer } from '@/sync/storageTypes';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';
import { parseRawRequestUserInputQuestions } from './parseRawRequestUserInputQuestions';

/** Inline renderer for Happy/Codex request_user_input communications. */
export const RequestUserInputView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');

    const submittedAnswers = React.useMemo<InlineQuestionAnswers | null>(() => {
        if (!communication || communication.status !== 'answered') return null;
        const answers: InlineQuestionAnswers = {};
        for (const [questionId, answer] of Object.entries(communication.answers ?? {})) {
            answers[questionId] = {
                options: answer.options,
                ...(answer.custom ? { custom: answer.custom } : {}),
            };
        }
        return answers;
    }, [communication]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !communication || communication.status !== 'pending') return;

        const communicationAnswers: Record<string, AgentQuestionAnswer> = {};
        for (const question of communication.questions) {
            const answer = answers[question.id];
            const options = answer
                ? (question.multiSelect ? answer.options : answer.options.slice(0, 1))
                : [];
            if (options.length === 0 && !answer?.custom) continue;
            communicationAnswers[question.id] = {
                options,
                ...(answer?.custom ? { custom: answer.custom } : {}),
            };
        }
        await sessionAnswerQuestion(sessionId, communication.id, communicationAnswers, communication.kind);
    }, [communication, sessionId]);

    const rawQuestions = React.useMemo(
        () => (communication ? [] : parseRawRequestUserInputQuestions(tool.input)),
        [communication, tool.input],
    );

    if (communication) {
        return (
            <InlineQuestionForm
                questions={communication.questions}
                canInteract={tool.state === 'running' && communication.status === 'pending'}
                submittedAnswers={submittedAnswers}
                disabledStatus={communication.status === 'cancelled' ? 'superseded' : undefined}
                onSubmit={handleSubmit}
            />
        );
    }

    if (rawQuestions.length === 0) {
        return null;
    }

    const isTerminated = tool.state === 'error' || tool.state === 'completed';

    return (
        <InlineQuestionForm
            questions={rawQuestions}
            canInteract={false}
            disabledStatus={isTerminated ? 'superseded' : 'waiting'}
            onSubmit={async () => {}}
        />
    );
});
