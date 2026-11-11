import { describe, expect, it } from 'vitest';
import type { AsyncQuestionResponse } from '@slopus/happy-wire';
import { createCodexAsyncQuestionHandler, deliverCodexAsyncQuestionAnswer, recoverAsyncQuestionResponses } from './codexAsyncQuestionRpc';

function harness() {
    const responses = new Map<string, AsyncQuestionResponse>();
    const delivered: string[] = [];
    const questions = [{ title: 'Include screenshots?', options: ['Yes', 'No'] }, { title: 'Which pages?' }];
    const deps = {
        async readQuestions(id: string) { return id === 'question' ? questions : undefined; },
        readResponse: (id: string) => responses.get(id),
        async updateResponse(id: string, update: (current: AsyncQuestionResponse | undefined) => AsyncQuestionResponse) { responses.set(id, update(responses.get(id))); },
        async deliver(text: string, _clientMessageId: string) { delivered.push(text); },
    };
    return { responses, delivered, deps, handler: createCodexAsyncQuestionHandler(deps) };
}
const answer = { action: 'answer' as const, itemId: 'question', answers: ['No', 'Project and session pages'] };

describe('Codex asynchronous question responses', () => {
    it('delivers the question context once for concurrent devices and keeps a durable receipt', async () => {
        const h = harness();
        const [a, b] = await Promise.all([h.handler(answer), h.handler({ ...answer, answers: ['Yes', 'Everything'] })]);
        expect(a).toEqual(b);
        expect(a.status).toBe('answered');
        expect(h.delivered).toEqual(['Include screenshots?\nNo\n\nWhich pages?\nProject and session pages']);
        const resumed = createCodexAsyncQuestionHandler(h.deps);
        expect(await resumed(answer)).toEqual(a);
        expect(h.delivered).toHaveLength(1);
    });
    it('ignores a dismissed question after worker recreation without sending anything', async () => {
        const h = harness();
        await h.handler({ action: 'dismiss', itemId: 'question' });
        expect((await createCodexAsyncQuestionHandler(h.deps)(answer)).status).toBe('dismissed');
        expect(h.delivered).toEqual([]);
    });
    it('rejects unknown questions and incomplete answers before claiming or delivering', async () => {
        const h = harness();
        await expect(h.handler({ ...answer, itemId: 'unknown' })).rejects.toThrow('no longer available');
        await expect(h.handler({ ...answer, answers: ['No'] })).rejects.toThrow('every question');
        expect(h.responses.size).toBe(0);
        expect(h.delivered).toEqual([]);
    });
    it('retains an ambiguous delivery instead of resending it after a retry or restart', async () => {
        const h = harness();
        h.deps.deliver = async text => { h.delivered.push(text); throw new Error('ack lost'); };
        const handler = createCodexAsyncQuestionHandler(h.deps);
        expect((await handler(answer)).status).toBe('uncertain');
        expect((await handler(answer)).answers).toEqual(answer.answers);
        await createCodexAsyncQuestionHandler(h.deps)(answer);
        expect(h.delivered).toHaveLength(1);
    });
    it('does not resend a durable claim left by a crashed worker', async () => {
        const h = harness();
        h.responses.set('question', { status: 'sending', answers: answer.answers, updatedAt: 1 });
        expect((await h.handler(answer)).status).toBe('uncertain');
        expect(h.delivered).toEqual([]);
    });
    it('honors the winner of a metadata compare-and-swap conflict', async () => {
        const h = harness();
        h.deps.updateResponse = async (id, update) => {
            const winner: AsyncQuestionResponse = { status: 'dismissed', updatedAt: 3, requestId: 'other-worker' };
            h.responses.set(id, update(winner));
        };
        expect((await createCodexAsyncQuestionHandler(h.deps)(answer)).status).toBe('dismissed');
        expect(h.delivered).toEqual([]);
    });
    it('does not deliver if the durable claim cannot be confirmed', async () => {
        const h = harness();
        h.deps.updateResponse = async () => {};
        await expect(createCodexAsyncQuestionHandler(h.deps)(answer)).rejects.toThrow('save');
        expect(h.delivered).toEqual([]);
    });
});


describe('question delivery follows the live turn, not the originating turn', () => {
    it('steers an active turn and enqueues a reply when the task has already ended', async () => {
        let turnId: string | null = 'current-turn';
        const actions: string[] = [];
        const deps = { activeTurnId: () => turnId,
            async steer(_text: string, turn: string, _id: string) { actions.push(`steer:${turn}`); },
            async enqueue(_text: string, _id: string) { actions.push('enqueue'); } };
        await deliverCodexAsyncQuestionAnswer(deps, 'Answer', 'id');
        turnId = null;
        await deliverCodexAsyncQuestionAnswer(deps, 'Answer', 'id-next');
        expect(actions).toEqual(['steer:current-turn', 'enqueue']);
    });
    it('never silently resends through the queue after a steering acknowledgement is lost', async () => {
        let queued = false;
        await expect(deliverCodexAsyncQuestionAnswer({ activeTurnId: () => 'turn',
            async steer() { throw new Error('ack lost'); }, async enqueue() { queued = true; },
        }, 'Answer', 'id')).rejects.toThrow('ack lost');
        expect(queued).toBe(false);
    });
});


describe('worker restart recovery', () => {
    it('turns interrupted sends into visible uncertainty and preserves completed receipts', () => {
        const answered: AsyncQuestionResponse = { status: 'answered', answers: ['No'], updatedAt: 1 };
        const recovered = recoverAsyncQuestionResponses({ done: answered, pending: { status: 'sending', answers: ['Yes'], updatedAt: 2 } })!;
        expect(recovered.done).toBe(answered);
        expect(recovered.pending).toMatchObject({ status: 'uncertain', answers: ['Yes'] });
        expect(recoverAsyncQuestionResponses(recovered)).toBe(recovered);
    });
});
