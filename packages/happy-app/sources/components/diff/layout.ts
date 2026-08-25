/**
 * Layout decisions the renderer makes before drawing anything.
 *
 * These are pure on purpose: which rows are visible and how wide the gutter is
 * are the two things that silently break (a gutter that disagrees with the code
 * beside it, a collapse that cuts a change in half), and they are far easier to
 * pin down with a test than with a screenshot.
 */

import type { DiffRow } from './engine/types';

export interface VisibleRowsOptions {
    showHunkHeaders: boolean;
    expanded: boolean;
    collapseAfter: number;
}

export interface VisibleRows {
    rows: DiffRow[];
    /** Rows the collapse is holding back, for the "show more" button. */
    hiddenCount: number;
}

/**
 * How far past the collapse limit we will go to finish a change block. Bounded
 * so a pathological file of nothing but changes can't defeat the collapse.
 */
const MAX_SNAP = 200;

function isChangeLine(row: DiffRow | undefined): boolean {
    return row !== undefined && row.kind === 'line' && row.type !== 'ctx';
}

export function selectVisibleRows(rows: DiffRow[], options: VisibleRowsOptions): VisibleRows {
    const visible = options.showHunkHeaders ? rows : rows.filter((r) => r.kind !== 'hunk');

    if (options.expanded || visible.length <= options.collapseAfter) {
        return { rows: visible, hiddenCount: 0 };
    }

    let end = options.collapseAfter;

    // Never cut through a run of removals and the additions that replaced them:
    // side by side, the removals would render opposite empty cells, which reads
    // as "this code was deleted" rather than "the rest is one tap away".
    if (isChangeLine(visible[end - 1]) && isChangeLine(visible[end])) {
        const limit = Math.min(visible.length, end + MAX_SNAP);
        while (end < limit && isChangeLine(visible[end])) end++;
    }

    return { rows: visible.slice(0, end), hiddenCount: visible.length - end };
}

/**
 * Width of the pinned gutter. The marker column is always drawn; line numbers
 * are optional and sized by the widest number the file will show.
 */
export function gutterWidthFor(charWidth: number, maxLineNo: number, showLineNumbers: boolean): number {
    const markerColumns = 2;
    const digits = showLineNumbers ? Math.max(2, String(Math.max(1, maxLineNo)).length) : 0;
    return Math.ceil((digits + markerColumns) * charWidth) + (showLineNumbers ? 12 : 4);
}
