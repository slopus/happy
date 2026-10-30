import { describe, expect, it } from 'vitest';
import type { SideQuestionResult, SideQuestionTurn } from './sideQuestion';
import { createSideQuestionThreads } from './sideQuestionThreads';

type AskCall = {
    sessionId: string;
    question: string;
    history: SideQuestionTurn[];
    signal: AbortSignal;
    resolve: (result: SideQuestionResult) => void;
    reject: (error: unknown) => void;
};

/** Threads over a stubbed RPC whose questions stay unanswered until the test answers them. */
function threadsWithStubbedRpc(options: { online?: boolean } = {}) {
    const calls: AskCall[] = [];
    let online = options.online ?? true;
    const threads = createSideQuestionThreads({
        ask: (sessionId, question, history, signal) => new Promise<SideQuestionResult>((resolve, reject) => {
            calls.push({ sessionId, question, history, signal, resolve, reject });
        }),
        isOnline: () => online,
    });
    return { threads, calls, setOnline: (value: boolean) => { online = value; } };
}

const answered = (response: string): SideQuestionResult => ({
    status: 'answered',
    answer: { response, synthetic: false },
});

/** Lets the settled RPC promises run their callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('side question threads', () => {
    it('keeps a thread and its answer with no panel on screen', async () => {
        // Nothing renders here at all: the thread does not depend on a screen,
        // which is what leaving the chat for the session list amounts to
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'what changed?');
        expect(threads.getThread('chat-a')?.exchanges).toEqual([
            { question: 'what changed?', state: { status: 'asking' } },
        ]);

        calls[0].resolve(answered('Two files.'));
        await flush();
        expect(threads.getThread('chat-a')?.exchanges).toEqual([
            { question: 'what changed?', state: { status: 'answered', response: 'Two files.', synthetic: false } },
        ]);
    });

    it('keeps each chat to its own thread', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'about a?');
        threads.open('chat-b', 'about b?');
        expect(calls.map((call) => [call.sessionId, call.question])).toEqual([['chat-a', 'about a?'], ['chat-b', 'about b?']]);

        calls[0].resolve(answered('A.'));
        await flush();
        expect(threads.getThread('chat-a')?.exchanges[0].state).toEqual({ status: 'answered', response: 'A.', synthetic: false });
        expect(threads.getThread('chat-b')?.exchanges[0].state).toEqual({ status: 'asking' });
    });

    it('asks a question sent mid-answer once that answer is in, with it as history', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'first?');
        threads.open('chat-a', 'second?');
        expect(calls).toHaveLength(1);
        expect(threads.getThread('chat-a')?.exchanges[1]).toEqual({ question: 'second?', state: { status: 'queued' } });

        calls[0].resolve(answered('One.'));
        await flush();
        expect(calls).toHaveLength(2);
        expect(calls[1].question).toBe('second?');
        expect(calls[1].history).toEqual([{ question: 'first?', response: 'One.' }]);
        expect(threads.getThread('chat-a')?.exchanges[1].state).toEqual({ status: 'asking' });
    });

    it('sends the follow-up typed in the panel and clears the field', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'first?');
        calls[0].resolve(answered('One.'));
        await flush();

        threads.setDraft('chat-a', '  and then?  ');
        expect(threads.getThread('chat-a')?.draft).toBe('  and then?  ');
        threads.sendDraft('chat-a');
        expect(threads.getThread('chat-a')?.draft).toBe('');
        expect(calls[1].question).toBe('and then?');
        expect(calls[1].history).toEqual([{ question: 'first?', response: 'One.' }]);

        // A blank field sends nothing
        threads.setDraft('chat-a', '   ');
        threads.sendDraft('chat-a');
        expect(calls).toHaveLength(2);
    });

    it('opens nothing without a question, and leaves an open thread as it is', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', '   ');
        expect(threads.getThread('chat-a')).toBeNull();
        expect(calls).toHaveLength(0);

        threads.open('chat-a', 'what changed?');
        calls[0].resolve(answered('Two files.'));
        await flush();
        const before = threads.getThread('chat-a');
        threads.open('chat-a', '');
        expect(threads.getThread('chat-a')).toBe(before);
        expect(calls).toHaveLength(1);
    });

    it('cancels the question in flight on close, and a late answer lands nowhere', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'slow?');
        threads.close('chat-a');
        expect(calls[0].signal.aborted).toBe(true);
        expect(threads.getThread('chat-a')).toBeNull();

        // The chat starts a new thread before the old answer comes back
        threads.open('chat-a', 'fresh?');
        calls[0].resolve(answered('Stale.'));
        await flush();
        expect(threads.getThread('chat-a')?.exchanges).toEqual([
            { question: 'fresh?', state: { status: 'asking' } },
        ]);

        calls[1].resolve(answered('Fresh.'));
        await flush();
        expect(threads.getThread('chat-a')?.exchanges[0].state).toEqual({ status: 'answered', response: 'Fresh.', synthetic: false });
    });

    it('explains an offline chat without asking it', () => {
        const { threads, calls } = threadsWithStubbedRpc({ online: false });
        threads.open('chat-a', 'anyone there?');
        threads.open('chat-a', 'still?');
        expect(calls).toHaveLength(0);
        expect(threads.getThread('chat-a')?.exchanges.map((exchange) => exchange.state)).toEqual([
            { status: 'notice', notice: 'offline' },
            { status: 'notice', notice: 'offline' },
        ]);
    });

    it('turns what the CLI reports into states the panel can explain', async () => {
        const { threads, calls, setOnline } = threadsWithStubbedRpc();
        const states = () => threads.getThread('chat-a')?.exchanges.map((exchange) => exchange.state);
        threads.open('chat-a', 'q1');
        calls[0].resolve({ status: 'unavailable', reason: 'local' });
        await flush();
        threads.open('chat-a', 'q2');
        calls[1].reject(new Error('RPC method not available'));
        await flush();
        threads.open('chat-a', 'q3');
        calls[2].reject(new Error('boom'));
        await flush();
        threads.open('chat-a', 'q4');
        calls[3].resolve({ status: 'cancelled' });
        await flush();
        threads.open('chat-a', 'q5');
        setOnline(false);
        calls[4].reject(new Error('socket closed'));
        await flush();

        expect(states()).toEqual([
            { status: 'notice', notice: 'local' },
            { status: 'notice', notice: 'cli-outdated' },
            { status: 'failed', error: 'boom' },
            { status: 'answered', response: null, synthetic: false },
            { status: 'notice', notice: 'offline' },
        ]);
    });

    it('leaves synthetic and empty answers out of a follow-up history', async () => {
        const { threads, calls } = threadsWithStubbedRpc();
        threads.open('chat-a', 'q1');
        calls[0].resolve({ status: 'answered', answer: { response: 'Canned.', synthetic: true } });
        await flush();
        threads.open('chat-a', 'q2');
        calls[1].resolve({ status: 'answered', answer: { response: null, synthetic: false } });
        await flush();
        threads.open('chat-a', 'q3');
        calls[2].resolve(answered('Real.'));
        await flush();
        threads.open('chat-a', 'q4');
        expect(calls[3].history).toEqual([{ question: 'q3', response: 'Real.' }]);
    });
});
