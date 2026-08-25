import { describe, expect, it } from 'vitest';
import { buildDiffFromPatch } from './buildDiff';
import { buildSplitRows } from './splitRows';
import type { DiffRow } from './types';

function line(
    key: string,
    type: 'add' | 'del' | 'ctx',
    text: string,
    oldNo?: number,
    newNo?: number,
): DiffRow {
    return { kind: 'line', key, type, text, oldNo, newNo, spans: [{ t: text, k: 'plain', e: 0 }] };
}

describe('buildSplitRows', () => {
    it('puts a context line on both sides', () => {
        const ctx = line('a', 'ctx', 'same', 1, 1);
        const rows = buildSplitRows([ctx]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'pair', left: ctx, right: ctx });
    });

    it('pairs a removal with the addition that replaced it', () => {
        const del = line('d', 'del', 'old', 4);
        const add = line('a', 'add', 'new', undefined, 4);
        const rows = buildSplitRows([del, add]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'pair', left: del, right: add });
    });

    it('pairs runs positionally and pads the shorter side with null', () => {
        const rows = buildSplitRows([
            line('d0', 'del', 'a', 1),
            line('d1', 'del', 'b', 2),
            line('d2', 'del', 'c', 3),
            line('a0', 'add', 'A', undefined, 1),
        ]);

        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ left: { key: 'd0' }, right: { key: 'a0' } });
        expect(rows[1]).toMatchObject({ left: { key: 'd1' }, right: null });
        expect(rows[2]).toMatchObject({ left: { key: 'd2' }, right: null });
    });

    it('leaves the old side empty for a pure addition', () => {
        const rows = buildSplitRows([line('a0', 'add', 'added', undefined, 7)]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'pair', left: null, right: { key: 'a0' } });
    });

    it('spans hunk and message rows across both columns', () => {
        const rows = buildSplitRows([
            { kind: 'hunk', key: 'h0', text: '@@ -1,2 +1,2 @@', section: '' },
            { kind: 'message', key: 'm0', code: 'binary' },
        ]);
        expect(rows.map((r) => r.kind)).toEqual(['full', 'full']);
    });

    it('produces unique keys so lists do not collide', () => {
        const doc = buildDiffFromPatch([
            '--- a/x.ts',
            '+++ b/x.ts',
            '@@ -1,4 +1,4 @@',
            ' const a = 1;',
            '-const b = 2;',
            '-const c = 3;',
            '+const b = 20;',
            ' const d = 4;',
            '@@ -10,2 +10,3 @@',
            ' const e = 5;',
            '+const f = 6;',
            '',
        ].join('\n'));

        const rows = buildSplitRows(doc.files[0].rows);
        const keys = rows.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('keeps every line from the unified rows', () => {
        const doc = buildDiffFromPatch([
            '--- a/x.ts',
            '+++ b/x.ts',
            '@@ -1,3 +1,3 @@',
            ' keep',
            '-drop',
            '+gain',
            '',
        ].join('\n'));

        const unified = doc.files[0].rows.filter((r) => r.kind === 'line');
        const split = buildSplitRows(doc.files[0].rows);
        const seen = new Set<string>();
        for (const row of split) {
            if (row.kind !== 'pair') continue;
            if (row.left) seen.add(row.left.key);
            if (row.right) seen.add(row.right.key);
        }
        expect(seen.size).toBe(unified.length);
    });
});
