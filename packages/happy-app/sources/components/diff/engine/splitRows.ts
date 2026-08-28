/**
 * Pairs unified rows into side-by-side rows.
 *
 * A unified diff lists removals and then additions; a split view has to decide
 * which removal sits opposite which addition. Pairing is positional (i-th
 * removal with i-th addition) for the same reason the word-level diff pairs
 * that way: it matches how edits actually land, and any cleverer matching
 * disagrees with the intra-line emphasis already baked into the spans.
 *
 * Runs of unequal length pad with `null`, which renders as an empty cell.
 */

import type { DiffRow } from './types';

export type DiffLineRow = Extract<DiffRow, { kind: 'line' }>;

export type SplitRow =
    | {
        kind: 'full';
        key: string;
        /** Hunk separators and messages span both columns. */
        row: Extract<DiffRow, { kind: 'hunk' } | { kind: 'message' }>;
    }
    | {
        kind: 'pair';
        key: string;
        /** Old side. Null when the change is a pure addition. */
        left: DiffLineRow | null;
        /** New side. Null when the change is a pure deletion. */
        right: DiffLineRow | null;
    };

function isLineOfType(row: DiffRow | undefined, type: DiffLineRow['type']): row is DiffLineRow {
    return row !== undefined && row.kind === 'line' && row.type === type;
}

export function buildSplitRows(rows: DiffRow[]): SplitRow[] {
    const out: SplitRow[] = [];
    let i = 0;

    while (i < rows.length) {
        const row = rows[i];

        if (row.kind !== 'line') {
            out.push({ kind: 'full', key: row.key, row });
            i++;
            continue;
        }

        if (row.type === 'ctx') {
            // Context exists on both sides, so the same row renders twice.
            out.push({ kind: 'pair', key: row.key, left: row, right: row });
            i++;
            continue;
        }

        let delEnd = i;
        while (isLineOfType(rows[delEnd], 'del')) delEnd++;
        let addEnd = delEnd;
        while (isLineOfType(rows[addEnd], 'add')) addEnd++;

        const dels = rows.slice(i, delEnd) as DiffLineRow[];
        const adds = rows.slice(delEnd, addEnd) as DiffLineRow[];

        const height = Math.max(dels.length, adds.length);
        for (let p = 0; p < height; p++) {
            const left = dels[p] ?? null;
            const right = adds[p] ?? null;
            out.push({
                kind: 'pair',
                key: `${left?.key ?? '_'}|${right?.key ?? '_'}`,
                left,
                right,
            });
        }

        // Guaranteed to advance: we only get here on a `del` or `add` row, so
        // at least one of the two runs consumed it.
        i = addEnd;
    }

    return out;
}
