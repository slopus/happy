import { describe, expect, it } from 'vitest';
import { buildDiffFromPatch } from '../engine/buildDiff';
import { applySyntax, planSyntax } from './plan';
import { tokenize } from './tokenize';

const patch = [
    '--- a/sample.ts', '+++ b/sample.ts', '@@ -1,3 +1,3 @@',
    ' /* comment', '    still comment */', '-const count = 1;', '+const count = 2;',
    '@@ -20,1 +20,1 @@', '-const hidden = true;', '+const hidden = false;',
].join('\n');

describe('viewport syntax plan', () => {
    it('only requests hunks intersecting displayed rows but retains complete hunk context', () => {
        const file = buildDiffFromPatch(patch).files[0];
        const plan = planSyntax(file, [file.rows[2]]);
        expect(plan).toHaveLength(1);
        expect(plan[0].input.lines).toHaveLength(4);
        expect(plan[0].input.lines[0].text).toBe('/* comment');
    });

    it('overlays token colors without mutating text, word emphasis, or base rows', () => {
        const file = buildDiffFromPatch(patch).files[0];
        const before = JSON.stringify(file);
        const plan = planSyntax(file, file.rows);
        const outcomes = new Map(plan.map((hunk) => [hunk.key, { status: 'highlighted' as const, result: tokenize(hunk.input) }]));
        const next = applySyntax(file.rows, plan, outcomes);
        expect(next).not.toBe(file.rows);
        expect(next[0]).toBe(file.rows[0]);
        expect(JSON.stringify(file)).toBe(before);
        for (let i = 0; i < next.length; i++) {
            const row = next[i];
            const original = file.rows[i];
            if (row.kind !== 'line' || original.kind !== 'line') continue;
            expect(row.spans.map((span) => span.t).join('')).toBe(row.text);
            const expanded = (spans: typeof row.spans) => spans.flatMap((span) => Array(span.t.length).fill(span.e));
            expect(expanded(row.spans)).toEqual(expanded(original.spans));
        }
    });

    it('keeps unknown languages, huge hunks, and already highlighted rows untouched', () => {
        const file = buildDiffFromPatch(patch).files[0];
        expect(planSyntax({ ...file, language: null }, file.rows)).toEqual([]);
        const highlighted = buildDiffFromPatch(patch, { syntax: true }).files[0];
        expect(planSyntax(highlighted, highlighted.rows)).toEqual([]);
        const huge = buildDiffFromPatch(`--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(2001)}`).files[0];
        expect(planSyntax(huge, huge.rows)).toEqual([]);
        expect(applySyntax(file.rows, planSyntax(file, file.rows), new Map())).toBe(file.rows);
    });
});