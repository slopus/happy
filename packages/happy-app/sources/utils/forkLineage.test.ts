import { describe, it, expect } from 'vitest';
import {
    orderSessionRowsByForkLineage,
    forkIndentPadding,
    FORK_INDENT_SIZE,
    FORK_MAX_VISUAL_DEPTH,
} from './forkLineage';

type Row = { id: string; parentSessionId: string | null; forkDepth: number };
const row = (id: string, parentSessionId: string | null = null): Row => ({ id, parentSessionId, forkDepth: 0 });
const ids = (rows: Row[]) => rows.map(r => r.id);
const depths = (rows: Row[]) => rows.map(r => r.forkDepth);

describe('orderSessionRowsByForkLineage', () => {
    it('leaves a fork-free list in original order at depth 0', () => {
        const out = orderSessionRowsByForkLineage([row('a'), row('b'), row('c')]);
        expect(ids(out)).toEqual(['a', 'b', 'c']);
        expect(depths(out)).toEqual([0, 0, 0]);
    });

    it('nests a child directly under its parent at depth 1', () => {
        // Input is newest-first: forked child 'b' sorts above its parent 'a'.
        const out = orderSessionRowsByForkLineage([row('b', 'a'), row('a'), row('c')]);
        expect(ids(out)).toEqual(['a', 'b', 'c']);
        expect(depths(out)).toEqual([0, 1, 0]);
    });

    it('nests a multi-level fork chain with increasing depth', () => {
        const out = orderSessionRowsByForkLineage([row('c', 'b'), row('b', 'a'), row('a')]);
        expect(ids(out)).toEqual(['a', 'b', 'c']);
        expect(depths(out)).toEqual([0, 1, 2]);
    });

    it('keeps a child at depth 0 when its parent is not in the same section', () => {
        const out = orderSessionRowsByForkLineage([row('b', 'parent-in-another-group'), row('c')]);
        expect(ids(out)).toEqual(['b', 'c']);
        expect(depths(out)).toEqual([0, 0]);
    });

    it('places multiple children under one parent, preserving their order', () => {
        const out = orderSessionRowsByForkLineage([row('c1', 'p'), row('c2', 'p'), row('p')]);
        expect(ids(out)).toEqual(['p', 'c1', 'c2']);
        expect(depths(out)).toEqual([0, 1, 1]);
    });

    it('does not loop or drop rows on a parent cycle', () => {
        // a -> b -> a, both present (pathological metadata).
        const out = orderSessionRowsByForkLineage([row('a', 'b'), row('b', 'a')]);
        expect(out).toHaveLength(2);
        expect(ids(out).sort()).toEqual(['a', 'b']);
    });

    it('returns the same row reference when depth is unchanged (deep-equal stability)', () => {
        const a = row('a');
        const b = row('b');
        const out = orderSessionRowsByForkLineage([a, b]);
        expect(out[0]).toBe(a);
        expect(out[1]).toBe(b);
    });
});

describe('forkIndentPadding', () => {
    it('adds no indent at depth 0', () => {
        expect(forkIndentPadding(0, 16)).toBe(16);
    });

    it('adds one indent step per level', () => {
        expect(forkIndentPadding(1, 16)).toBe(16 + FORK_INDENT_SIZE);
        expect(forkIndentPadding(2, 16)).toBe(16 + 2 * FORK_INDENT_SIZE);
    });

    it('caps the visual indent at FORK_MAX_VISUAL_DEPTH', () => {
        expect(forkIndentPadding(99, 16)).toBe(16 + FORK_MAX_VISUAL_DEPTH * FORK_INDENT_SIZE);
    });
});
