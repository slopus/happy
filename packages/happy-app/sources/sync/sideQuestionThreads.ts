/**
 * The `/btw` side threads, one per chat, kept apart from the screen that
 * shows them.
 *
 * A thread used to live inside a modal sheet, so whatever took the sheet away
 * took the thread too: a tap on the session list behind it, or Back, closed the
 * sheet, cancelled the question it was still waiting on, and left nothing to
 * come back to. Here the thread outlives the screen. Leaving the chat, for the
 * list or for another chat, keeps the question running; its answer lands in the
 * thread whether or not anyone is looking, and the chat shows the thread again
 * on the way back. Only closing the panel ends it.
 *
 * A thread answers one question at a time. One asked while another is being
 * answered waits its turn, and is then asked with that answer in its history,
 * the way a follow-up is.
 *
 * Memory-only, like pending chats: an app that was restarted has no question
 * in flight to rejoin.
 *
 * Nothing here touches the socket. The caller supplies `ask` (ops.ts
 * `sessionSideQuestion` in the app), so tests can drive a thread directly.
 */

import { create } from 'zustand';
import {
    SIDE_QUESTION_UNSUPPORTED_ERROR,
    type SideQuestionResult,
    type SideQuestionTurn,
    type SideQuestionUnavailableReason,
} from './sideQuestion';

/** Expected states the user can act on, such as Claude running in the terminal. */
export type SideQuestionNotice = SideQuestionUnavailableReason | 'offline' | 'cli-outdated';

export type SideQuestionExchangeState =
    /** Waiting for the question before it to be answered. */
    | { status: 'queued' }
    | { status: 'asking' }
    | { status: 'answered'; response: string | null; synthetic: boolean }
    | { status: 'notice'; notice: SideQuestionNotice }
    | { status: 'failed'; error: string };

export type SideQuestionExchange = {
    question: string;
    state: SideQuestionExchangeState;
};

export type SideQuestionThread = {
    exchanges: readonly SideQuestionExchange[];
    /** The follow-up being typed in the panel, kept so leaving the chat does not lose it. */
    draft: string;
    /** Opened with nothing asked, so the panel should take the keyboard once. */
    wantsFocus: boolean;
};

export type SideQuestionThreadsDeps = {
    ask: (
        sessionId: string,
        question: string,
        history: SideQuestionTurn[],
        signal: AbortSignal,
    ) => Promise<SideQuestionResult>;
    isOnline: (sessionId: string) => boolean;
};

type ThreadsState = {
    threads: Record<string, SideQuestionThread>;
};

const EMPTY_THREAD: SideQuestionThread = { exchanges: [], draft: '', wantsFocus: false };

export function createSideQuestionThreads(deps: SideQuestionThreadsDeps) {
    const useThreadsStore = create<ThreadsState>()(() => ({ threads: {} }));
    // The question each thread is waiting on. Kept outside the store: nothing
    // draws it, it is only there to be cancelled.
    const inFlight = new Map<string, AbortController>();

    const update = (sessionId: string, change: (thread: SideQuestionThread) => SideQuestionThread) => {
        useThreadsStore.setState((state) => {
            const thread = state.threads[sessionId];
            if (!thread) return state;
            const next = change(thread);
            return next === thread ? state : { threads: { ...state.threads, [sessionId]: next } };
        });
    };

    const settle = (sessionId: string, index: number, state: SideQuestionExchangeState) => {
        update(sessionId, (thread) => ({
            ...thread,
            exchanges: thread.exchanges.map((exchange, i) => (i === index ? { ...exchange, state } : exchange)),
        }));
    };

    const enqueue = (sessionId: string, question: string) => {
        update(sessionId, (thread) => ({
            ...thread,
            exchanges: [...thread.exchanges, { question, state: { status: 'queued' } }],
        }));
    };

    // Starts the oldest waiting question, unless the thread is already waiting on one.
    const askNext = (sessionId: string): void => {
        if (inFlight.has(sessionId)) return;
        const thread = useThreadsStore.getState().threads[sessionId];
        const index = thread?.exchanges.findIndex((exchange) => exchange.state.status === 'queued') ?? -1;
        if (!thread || index === -1) return;

        // An offline session would make the server wait 15 s and then answer
        // like a CLI that predates side questions
        if (!deps.isOnline(sessionId)) {
            settle(sessionId, index, { status: 'notice', notice: 'offline' });
            askNext(sessionId);
            return;
        }

        const history: SideQuestionTurn[] = thread.exchanges.slice(0, index).flatMap((exchange) => (
            exchange.state.status === 'answered' && exchange.state.response !== null && !exchange.state.synthetic
                ? [{ question: exchange.question, response: exchange.state.response }]
                : []
        ));
        const controller = new AbortController();
        inFlight.set(sessionId, controller);
        settle(sessionId, index, { status: 'asking' });

        const finish = (state: SideQuestionExchangeState) => {
            // Closed while it was being answered: the thread it belonged to is gone
            if (controller.signal.aborted) return;
            inFlight.delete(sessionId);
            settle(sessionId, index, state);
            askNext(sessionId);
        };
        deps.ask(sessionId, thread.exchanges[index].question, history, controller.signal).then(
            (result) => finish(describeResult(result)),
            (error: unknown) => finish(describeFailure(deps.isOnline(sessionId), error)),
        );
    };

    /**
     * `/btw` from the chat's composer: shows the chat's thread, starting one if
     * it has none, and asks `question` in it. An empty question only opens it,
     * ready to type one.
     */
    const open = (sessionId: string, question: string) => {
        const text = question.trim();
        useThreadsStore.setState((state) => ({
            threads: { ...state.threads, [sessionId]: state.threads[sessionId] ?? EMPTY_THREAD },
        }));
        if (text) {
            enqueue(sessionId, text);
            askNext(sessionId);
        } else {
            update(sessionId, (thread) => (thread.wantsFocus ? thread : { ...thread, wantsFocus: true }));
        }
    };

    const setDraft = (sessionId: string, draft: string) => {
        update(sessionId, (thread) => (thread.draft === draft ? thread : { ...thread, draft }));
    };

    /** Asks what is typed in the panel, and clears the field for the next one. */
    const sendDraft = (sessionId: string) => {
        const text = useThreadsStore.getState().threads[sessionId]?.draft.trim();
        if (!text) return;
        setDraft(sessionId, '');
        enqueue(sessionId, text);
        askNext(sessionId);
    };

    /** The panel took the keyboard it was asked to. */
    const focused = (sessionId: string) => {
        update(sessionId, (thread) => (thread.wantsFocus ? { ...thread, wantsFocus: false } : thread));
    };

    /** Ends the thread: drops the question still being answered, and forgets the rest. */
    const close = (sessionId: string) => {
        inFlight.get(sessionId)?.abort();
        inFlight.delete(sessionId);
        useThreadsStore.setState((state) => {
            if (!state.threads[sessionId]) return state;
            const { [sessionId]: _closed, ...threads } = state.threads;
            return { threads };
        });
    };

    const getThread = (sessionId: string): SideQuestionThread | null => (
        useThreadsStore.getState().threads[sessionId] ?? null
    );

    function useThread(sessionId: string): SideQuestionThread | null {
        return useThreadsStore((state) => state.threads[sessionId] ?? null);
    }

    return { open, setDraft, sendDraft, focused, close, getThread, useThread };
}

function describeResult(result: SideQuestionResult): SideQuestionExchangeState {
    switch (result.status) {
        case 'answered':
            return { status: 'answered', response: result.answer.response, synthetic: result.answer.synthetic };
        case 'unavailable':
            return { status: 'notice', notice: result.reason };
        case 'cancelled':
            return { status: 'answered', response: null, synthetic: false };
    }
}

function describeFailure(online: boolean, error: unknown): SideQuestionExchangeState {
    if (!online) {
        return { status: 'notice', notice: 'offline' };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === SIDE_QUESTION_UNSUPPORTED_ERROR) {
        return { status: 'notice', notice: 'cli-outdated' };
    }
    return { status: 'failed', error: message };
}
