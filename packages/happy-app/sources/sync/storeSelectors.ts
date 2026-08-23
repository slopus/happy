import equal from 'fast-deep-equal';
import React from 'react';

/**
 * The comparison on its own, given somewhere to remember the last result: a
 * newly computed result that is merely *equal* to the previous one comes back
 * as the previous one, so its identity never changes.
 *
 * Kept free of React so the behaviour can be exercised directly.
 */
export function memoizeDeepEqual<TState, TResult>(
    selector: (state: TState) => TResult,
    previous: { current: TResult | undefined },
): (state: TState) => TResult {
    return (state: TState) => {
        const next = selector(state);
        return equal(previous.current, next) ? previous.current! : (previous.current = next);
    };
}

/**
 * Wraps a store selector so an unchanged store keeps returning the same object.
 *
 * `useSyncExternalStore`, which zustand reads the store through, re-renders when
 * the snapshot's identity changes and re-reads the snapshot after every render.
 * A selector that mints its result — a derived list, or objects built out of
 * stored fields — hands back a new identity on every read and so never settles:
 * render, re-read, differ, render again, until React gives up with "Maximum
 * update depth exceeded".
 *
 * `useShallow` covers the common case, a fresh array holding stored elements.
 * This covers the one it cannot: fresh *elements*, which shallow compares by
 * identity and always calls different.
 */
export function useDeepEqual<TState, TResult>(
    selector: (state: TState) => TResult,
): (state: TState) => TResult {
    return memoizeDeepEqual(selector, React.useRef<TResult>(undefined));
}
