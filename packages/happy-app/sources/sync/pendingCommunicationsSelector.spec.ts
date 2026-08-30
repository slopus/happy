import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';

import { selectAgentFormCommunication, selectPendingCommunications } from './agentCommunications';
import { memoizeDeepEqual } from './storeSelectors';
import type { AgentState } from './storageTypes';

/**
 * A session while the agent waits on an answer. One pending form is enough:
 * the render loop needed only a single freshly-minted element, which is why
 * sessions holding no question never showed it.
 */
function agentState(completed?: Record<string, unknown>): AgentState {
    return {
        communications: {
            'call-1': {
                kind: 'form',
                createdAt: 5,
                form: {
                    questions: [{
                        id: 'q1',
                        header: 'Storage',
                        question: 'Where should it live?',
                        options: [{ label: 'Settings' }],
                    }],
                },
            },
        },
        completedCommunications: completed,
    } as unknown as AgentState;
}

type State = { agentState: AgentState | null };

function reader() {
    return memoizeDeepEqual(
        (state: State) => selectPendingCommunications(state.agentState),
        { current: undefined },
    );
}

/**
 * Guards the render loop that crashed any session holding a question:
 * `useSyncExternalStore` re-reads the snapshot after every render and
 * re-renders whenever its identity changed, so a selector whose identity never
 * settles never stops rendering.
 */
describe('pending communications through the store', () => {
    it('hands back the identical list while the store is unchanged', () => {
        const read = reader();
        const state = { agentState: agentState() };

        const first = read(state);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ id: 'call-1', kind: 'form' });
        // Identity, not equality: this is the whole thing that ends the loop.
        expect(read(state)).toBe(first);
        expect(read(state)).toBe(first);
    });

    it('still reports a real change once the question is answered', () => {
        const read = reader();
        const first = read({ agentState: agentState() });

        const answered = read({ agentState: agentState({ 'call-1': { status: 'answered' } }) });
        expect(answered).not.toBe(first);
        expect(answered).toEqual([]);
    });

    it('settles the form joined to a transcript tool call too', () => {
        // Same trap, second selector: the returned object is fresh, and its
        // `questions` comes from a .filter() that allocates every call, so
        // shallow — which compares those values by identity — never agrees.
        const state = { agentState: agentState() };
        const a = selectAgentFormCommunication(state.agentState, 'call-1');
        const b = selectAgentFormCommunication(state.agentState, 'call-1');
        expect(a).toEqual(b);
        expect(shallow(a, b)).toBe(false);

        const read = memoizeDeepEqual(
            (s: State) => selectAgentFormCommunication(s.agentState, 'call-1'),
            { current: undefined },
        );
        const first = read(state);
        expect(first).toMatchObject({ id: 'call-1', kind: 'form' });
        expect(read(state)).toBe(first);
    });

    it('mints fresh objects, which is why shallow comparison could not settle it', () => {
        const state = { agentState: agentState() };
        const a = selectPendingCommunications(state.agentState);
        const b = selectPendingCommunications(state.agentState);

        // The same reading twice over: equal in content, new objects every time.
        expect(a).toEqual(b);
        expect(a[0]).not.toBe(b[0]);
        // Shallow compares those elements by identity and so always disagrees —
        // the previous behaviour, and the loop.
        expect(shallow(a, b)).toBe(false);
    });
});
