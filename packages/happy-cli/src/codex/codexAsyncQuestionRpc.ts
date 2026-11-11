import { randomUUID } from 'node:crypto';
import { asyncQuestionActionSchema, type AsyncQuestion, type AsyncQuestionAction, type AsyncQuestionResponse } from '@slopus/happy-wire';

/** A restarted worker cannot infer whether an interrupted delivery reached the model. */
export function recoverAsyncQuestionResponses(responses: Record<string, AsyncQuestionResponse> | undefined): typeof responses {
    if (!responses || !Object.values(responses).some(response => response.status === 'sending')) return responses;
    return Object.fromEntries(Object.entries(responses).map(([id, response]) => [id,
        response.status === 'sending' ? { ...response, status: 'uncertain' as const, updatedAt: Date.now() } : response,
    ]));
}

export function formatAsyncQuestionAnswer(questions: AsyncQuestion[], answers: string[]): string {
    return questions.map((question, index) => `${question.title}\n${answers[index]}`).join('\n\n');
}

/** Choose once from the current lifecycle. Never fall back after an ambiguous
 * steering error, which could otherwise execute the same answer twice. */
export async function deliverCodexAsyncQuestionAnswer(deps: {
    activeTurnId: () => string | null;
    steer: (text: string, turnId: string, clientMessageId: string) => Promise<unknown>;
    enqueue: (text: string, clientMessageId: string) => Promise<void>;
}, text: string, clientMessageId: string): Promise<void> {
    const turnId = deps.activeTurnId();
    if (turnId) await deps.steer(text, turnId, clientMessageId);
    else await deps.enqueue(text, clientMessageId);
}

/** One execution authority handles all devices. Claim durably before delivery;
 * a worker crash or an ambiguous transport result must never cause a resend. */
export function createCodexAsyncQuestionHandler(deps: {
    readQuestions: (itemId: string) => Promise<AsyncQuestion[] | undefined>;
    readResponse: (itemId: string) => AsyncQuestionResponse | undefined;
    updateResponse: (itemId: string, update: (current: AsyncQuestionResponse | undefined) => AsyncQuestionResponse) => Promise<void>;
    deliver: (text: string, clientMessageId: string) => Promise<void>;
}) {
    const inFlight = new Map<string, Promise<AsyncQuestionResponse>>();
    return async (input: AsyncQuestionAction): Promise<AsyncQuestionResponse> => {
        const request = asyncQuestionActionSchema.parse(input);
        const pending = inFlight.get(request.itemId);
        if (pending) return pending;
        const task = (async (): Promise<AsyncQuestionResponse> => {
            const previous = deps.readResponse(request.itemId);
            if (previous) {
                if (previous.status !== 'sending') return previous;
                const uncertain: AsyncQuestionResponse = { ...previous, status: 'uncertain', updatedAt: Date.now() };
                await deps.updateResponse(request.itemId, current => current?.status === 'sending'
                    && current.requestId === previous.requestId ? uncertain : current ?? uncertain);
                return deps.readResponse(request.itemId) ?? uncertain;
            }
            const questions = await deps.readQuestions(request.itemId);
            if (!questions) throw new Error('This Codex question is no longer available.');
            if (request.action === 'answer' && questions.length !== request.answers.length) {
                throw new Error('Answer every question before submitting.');
            }
            const record: AsyncQuestionResponse = {
                status: request.action === 'dismiss' ? 'dismissed' : 'sending',
                ...(request.action === 'answer' ? { answers: request.answers } : {}),
                updatedAt: Date.now(), requestId: randomUUID(),
            };
            // A metadata CAS conflict re-runs this updater with the winner's state.
            await deps.updateResponse(request.itemId, current => current ?? record);
            const claimed = deps.readResponse(request.itemId);
            if (!claimed) throw new Error('Could not save the question response.');
            if (claimed.requestId !== record.requestId) {
                return claimed.status === 'sending' ? { ...claimed, status: 'uncertain' } : claimed;
            }
            if (request.action === 'dismiss') return claimed;
            let result: AsyncQuestionResponse;
            try {
                // Read the actual active turn inside deliver, after the claim;
                // the originating turn may already have completed meanwhile.
                await deps.deliver(formatAsyncQuestionAnswer(questions, request.answers), `async-question:${request.itemId}`);
                result = { ...record, status: 'answered', updatedAt: Date.now() };
            } catch {
                // Delivery may have reached Codex even if the acknowledgement
                // was lost. Keep the answer and direct the user to history.
                result = { ...record, status: 'uncertain', updatedAt: Date.now() };
            }
            await deps.updateResponse(request.itemId, current => current?.requestId === record.requestId ? result : current ?? result);
            return deps.readResponse(request.itemId) ?? result;
        })();
        inFlight.set(request.itemId, task);
        try { return await task; }
        finally { if (inFlight.get(request.itemId) === task) inFlight.delete(request.itemId); }
    };
}
