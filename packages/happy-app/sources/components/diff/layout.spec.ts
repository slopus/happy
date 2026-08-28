import { describe, expect, it } from 'vitest';
import { gutterWidthFor, selectVisibleRows } from './layout';
import type { DiffRow } from './engine/types';

function line(key: string, type: 'add' | 'del' | 'ctx'): DiffRow {
    return { kind: 'line', key, type, text: key, spans: [] };
}

function hunk(key: string): DiffRow {
    return { kind: 'hunk', key, text: '@@ -1 +1 @@', section: '' };
}

function ctxRun(count: number, prefix = 'c'): DiffRow[] {
    return Array.from({ length: count }, (_, i) => line(`${prefix}${i}`, 'ctx'));
}

describe('selectVisibleRows', () => {
    it('returns everything when the file is under the limit', () => {
        const rows = ctxRun(10);
        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: 80 });
        expect(result.rows).toBe(rows);
        expect(result.hiddenCount).toBe(0);
    });

    it('drops hunk separators when they are turned off', () => {
        const rows = [hunk('h0'), ...ctxRun(3)];
        const result = selectVisibleRows(rows, { showHunkHeaders: false, expanded: false, collapseAfter: 80 });
        expect(result.rows).toHaveLength(3);
        expect(result.rows.every((r) => r.kind === 'line')).toBe(true);
    });

    it('collapses to the limit and reports what is left', () => {
        const rows = ctxRun(100);
        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: 80 });
        expect(result.rows).toHaveLength(80);
        expect(result.hiddenCount).toBe(20);
    });

    it('shows everything once expanded', () => {
        const rows = ctxRun(100);
        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: true, collapseAfter: 80 });
        expect(result.rows).toHaveLength(100);
        expect(result.hiddenCount).toBe(0);
    });

    it('does not cut between removals and the additions that replaced them', () => {
        // Limit 10 would land between the removals and their additions.
        const rows = [
            ...ctxRun(8),
            line('d0', 'del'),
            line('d1', 'del'),
            line('a0', 'add'),
            line('a1', 'add'),
            ...ctxRun(20, 'tail'),
        ];

        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: 10 });
        const keys = result.rows.map((r) => r.key);

        expect(keys).toContain('a0');
        expect(keys).toContain('a1');
        expect(result.rows).toHaveLength(12);
        expect(result.hiddenCount).toBe(20);
    });

    it('still cuts when the limit lands on a context line', () => {
        const rows = [...ctxRun(20), line('d0', 'del'), line('a0', 'add')];
        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: 10 });
        expect(result.rows).toHaveLength(10);
        expect(result.hiddenCount).toBe(12);
    });

    it('bounds how far it will chase a change block', () => {
        // 500 consecutive changed lines: snapping must not swallow the file.
        const rows = [
            ...Array.from({ length: 500 }, (_, i) => line(`d${i}`, i % 2 === 0 ? 'del' : 'add')),
            ...ctxRun(10, 'tail'),
        ];
        const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: 100 });
        expect(result.rows.length).toBeLessThanOrEqual(300);
        expect(result.hiddenCount).toBeGreaterThan(0);
    });

    it('keeps the counts consistent no matter where the cut lands', () => {
        const rows = [
            ...ctxRun(5),
            line('d0', 'del'),
            line('a0', 'add'),
            ...ctxRun(5, 'mid'),
            line('d1', 'del'),
            line('a1', 'add'),
            ...ctxRun(5, 'tail'),
        ];
        for (let limit = 1; limit <= rows.length; limit++) {
            const result = selectVisibleRows(rows, { showHunkHeaders: true, expanded: false, collapseAfter: limit });
            expect(result.rows.length + result.hiddenCount).toBe(rows.length);
        }
    });
});

describe('gutterWidthFor', () => {
    it('reserves the marker column even without line numbers', () => {
        expect(gutterWidthFor(7, 1234, false)).toBe(Math.ceil(2 * 7) + 4);
    });

    it('grows with the widest line number', () => {
        const narrow = gutterWidthFor(7, 9, true);
        const wide = gutterWidthFor(7, 12345, true);
        expect(wide).toBeGreaterThan(narrow);
    });

    it('never sizes below two digits, so short files do not look cramped', () => {
        expect(gutterWidthFor(7, 1, true)).toBe(gutterWidthFor(7, 99, true));
    });

    it('scales with the measured character width', () => {
        expect(gutterWidthFor(10, 100, true)).toBeGreaterThan(gutterWidthFor(5, 100, true));
    });
});
