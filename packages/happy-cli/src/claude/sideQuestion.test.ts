import { describe, expect, it } from 'vitest';
import { createSideQuestionHandler, type AskSideQuestion, type SideQuestionAnswer, type SideQuestionTurn } from './sideQuestion';

type AskCall = {
    question: string;
    history: SideQuestionTurn[];
    signal: AbortSignal;
    resolve: (answer: SideQuestionAnswer) => void;
    reject: (error: Error) => void;
};

/** An ask function whose answers the test hands out by hand. */
function controlledAsk(): { ask: AskSideQuestion; calls: AskCall[] } {
    const calls: AskCall[] = [];
    const ask: AskSideQuestion = (question, { history, signal }) => new Promise((resolve, reject) => {
        calls.push({ question, history, signal, resolve, reject });
    });
    return { ask, calls };
}

const WAIT_MS = 20;

describe('createSideQuestionHandler', () => {
    it('returns the answer when it arrives within one wait', async () => {
        const { ask, calls } = controlledAsk();
        const handler = createSideQuestionHandler(() => ask, { waitMs: WAIT_MS });
        const history = [{ question: 'what file?', response: 'src/index.ts' }];

        const pending = handler({ type: 'ask', question: 'why that one?', history });
        expect(calls).toHaveLength(1);
        expect(calls[0].question).toBe('why that one?');
        expect(calls[0].history).toEqual(history);
        calls[0].resolve({ response: 'It is the entry point.', synthetic: false });

        await expect(pending).resolves.toEqual({
            status: 'answered',
            id: expect.any(String),
            answer: { response: 'It is the entry point.', synthetic: false },
        });
    });

    it('hands back an id for a slow answer and delivers it on a later wait', async () => {
        const { ask, calls } = controlledAsk();
        const handler = createSideQuestionHandler(() => ask, { waitMs: WAIT_MS });

        const first = await handler({ type: 'ask', question: 'summarize the plan' });
        expect(first).toEqual({ status: 'pending', id: expect.any(String) });
        if (first.status !== 'pending') throw new Error('unreachable');

        const second = handler({ type: 'wait', id: first.id });
        calls[0].resolve({ response: 'Three steps.', synthetic: false });
        await expect(second).resolves.toEqual({
            status: 'answered',
            id: first.id,
            answer: { response: 'Three steps.', synthetic: false },
        });

        // Collected answers are forgotten
        await expect(handler({ type: 'wait', id: first.id })).rejects.toThrow('no longer available');
    });

    it('aborts the question on cancel', async () => {
        const { ask, calls } = controlledAsk();
        const handler = createSideQuestionHandler(() => ask, { waitMs: WAIT_MS });

        const first = await handler({ type: 'ask', question: 'long one' });
        if (first.status !== 'pending') throw new Error('expected pending');

        await expect(handler({ type: 'cancel', id: first.id })).resolves.toEqual({ status: 'cancelled', id: first.id });
        expect(calls[0].signal.aborted).toBe(true);
        await expect(handler({ type: 'wait', id: first.id })).rejects.toThrow('no longer available');
    });

    it('reports why a question cannot be asked without calling ask', async () => {
        const handler = createSideQuestionHandler(() => 'local', { waitMs: WAIT_MS });
        await expect(handler({ type: 'ask', question: 'anything' })).resolves.toEqual({ status: 'unavailable', reason: 'local' });
    });

    it('surfaces a failed question as an error', async () => {
        const { ask, calls } = controlledAsk();
        const handler = createSideQuestionHandler(() => ask, { waitMs: WAIT_MS });

        const pending = handler({ type: 'ask', question: 'will fail' });
        calls[0].reject(new Error('Query closed'));
        await expect(pending).rejects.toThrow('Query closed');
    });

    it('rejects malformed requests', async () => {
        const { ask, calls } = controlledAsk();
        const handler = createSideQuestionHandler(() => ask, { waitMs: WAIT_MS });

        await expect(handler({ type: 'ask', question: '   ' })).rejects.toThrow('Invalid side question request');
        await expect(handler({ type: 'ask' })).rejects.toThrow('Invalid side question request');
        await expect(handler(null)).rejects.toThrow('Invalid side question request');
        expect(calls).toHaveLength(0);
    });
});
