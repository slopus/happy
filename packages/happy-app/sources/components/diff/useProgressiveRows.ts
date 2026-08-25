/**
 * Mounts a long row list across a few frames instead of all at once.
 *
 * Row virtualization is the usual answer, but it is the one thing this renderer
 * can't have: the pinned gutter and the horizontal scroll both rely on every
 * row of a file living in one container, and turning rows into list items
 * breaks them. Filling the list progressively buys most of the same win — the
 * first frame paints a screenful, the rest arrives over the next few frames —
 * while leaving the layout untouched.
 *
 * Short lists (the chat-sized diffs, which is most of them) skip the machinery
 * entirely and keep the caller's array identity, so nothing re-renders.
 *
 * Chunks are scheduled with `setTimeout`, deliberately not with
 * `requestAnimationFrame`: a backgrounded tab stops firing frames entirely, and
 * a fill that stalls there leaves the file silently truncated with no way to ask
 * for the rest. Timers are throttled in the background rather than stopped, so
 * the list always finishes.
 */

import * as React from 'react';

/** Rows mounted on the first frame. Comfortably more than one screenful. */
const INITIAL = 120;
/** Rows added per frame afterwards. */
const CHUNK = 200;

export function useProgressiveRows<T>(rows: T[], initial: number = INITIAL, chunk: number = CHUNK): T[] {
    const [count, setCount] = React.useState(() => Math.min(rows.length, initial));

    // A new document starts over: whatever was mounted belongs to the old one.
    React.useEffect(() => {
        setCount(Math.min(rows.length, initial));
    }, [rows, initial]);

    React.useEffect(() => {
        if (count >= rows.length) return;
        const id = setTimeout(() => {
            setCount((current) => Math.min(rows.length, current + chunk));
        }, 0);
        return () => clearTimeout(id);
    }, [count, rows.length, chunk]);

    return React.useMemo(
        () => (count >= rows.length ? rows : rows.slice(0, count)),
        [rows, count],
    );
}
