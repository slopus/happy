import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer, { act } from 'react-test-renderer';
import { useProgressiveRows } from './useProgressiveRows';

// Tells React that `act` is legitimate here, so effects flush synchronously
// instead of warning and leaving updates queued.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renders the hook in a component that draws nothing, so this runs in plain
 * node without a React Native environment.
 */
function mount(rows: unknown[], initial: number, chunk: number) {
    const lengths: number[] = [];
    const Probe = () => {
        lengths.push(useProgressiveRows(rows, initial, chunk).length);
        return null;
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(Probe));
    });
    return {
        lengths,
        /** Lets every pending chunk timer run to completion. */
        drain: () => {
            for (let i = 0; i < 100; i++) {
                act(() => { vi.advanceTimersByTime(1); });
                if (lengths[lengths.length - 1] >= rows.length) break;
            }
        },
        unmount: () => act(() => { renderer.unmount(); }),
    };
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('useProgressiveRows', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('returns a short list whole, without slicing it', () => {
        const rows = rowsOf(40);
        let received: unknown[] | null = null;
        const Probe = () => {
            received = useProgressiveRows(rows, 120, 200);
            return null;
        };
        act(() => { TestRenderer.create(React.createElement(Probe)); });
        // Identity is preserved so memoized children never see a new array.
        expect(received).toBe(rows);
    });

    it('mounts only the first window before any timer runs', () => {
        const { lengths } = mount(rowsOf(1000), 120, 200);
        expect(lengths[0]).toBe(120);
    });

    it('fills the rest in chunks and stops exactly at the end', () => {
        const { lengths, drain } = mount(rowsOf(1000), 120, 200);
        drain();
        expect(lengths[lengths.length - 1]).toBe(1000);
        // 120 → 320 → 520 → 720 → 920 → 1000
        expect(lengths).toEqual([120, 320, 520, 720, 920, 1000]);
    });

    it('never overshoots when the last chunk is partial', () => {
        const { lengths, drain } = mount(rowsOf(125), 120, 200);
        drain();
        expect(Math.max(...lengths)).toBe(125);
    });

    it('handles an empty list without scheduling anything', () => {
        const { lengths, drain } = mount([], 120, 200);
        drain();
        expect(lengths).toEqual([0]);
    });

    it('stops scheduling once unmounted', () => {
        const { drain, unmount } = mount(rowsOf(1000), 120, 200);
        unmount();
        expect(() => drain()).not.toThrow();
        expect(vi.getTimerCount()).toBe(0);
    });
});
