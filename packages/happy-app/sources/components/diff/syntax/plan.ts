import { mergeSpans } from '../engine/buildDiff';
import type { DiffFile, DiffRow, DiffSpan } from '../engine/types';
import { syntaxKey, type SyntaxOutcome } from './service';
import { withinSyntaxLimits, type SyntaxInput } from './protocol';

type Line = Extract<DiffRow, { kind: 'line' }>;
export interface SyntaxHunk {
    key: string;
    input: SyntaxInput;
    rows: Line[];
}

/** Only hunks intersecting the expanded preview are eligible, never hidden tails. */
export function planSyntax(file: DiffFile, displayed: DiffRow[]): SyntaxHunk[] {
    if (!file.language) return [];
    const wanted = new Set(displayed);
    const hunks: SyntaxHunk[] = [];
    let rows: Line[] = [];
    let intersects = false;
    const flush = () => {
        if (intersects && rows.length && !rows.some((row) => row.spans.some((span) => span.k !== 'plain'))) {
            const input: SyntaxInput = { language: file.language!, lines: rows.map(({ text, type }) => ({ text, type })) };
            // Whole contiguous hunks preserve comments/templates. Huge hunks
            // remain readable/plain instead of guessing state from a slice.
            if (withinSyntaxLimits(input)) hunks.push({ key: syntaxKey(input), input, rows });
        }
        rows = [];
        intersects = false;
    };
    for (const row of file.rows) {
        if (row.kind !== 'line') { flush(); continue; }
        rows.push(row);
        if (wanted.has(row)) intersects = true;
    }
    flush();
    return hunks;
}

/** Preserve the base document and unchanged row identities; overlay syntax only. */
export function applySyntax(displayed: DiffRow[], plan: SyntaxHunk[], outcomes: Map<string, SyntaxOutcome>): DiffRow[] {
    const wanted = new Set(displayed);
    const replacements = new Map<Line, Line>();
    for (const hunk of plan) {
        const outcome = outcomes.get(hunk.key);
        if (outcome?.status !== 'highlighted' || !outcome.result) continue;
        hunk.rows.forEach((row, index) => {
            if (!wanted.has(row)) return;
            const runs = outcome.result!.runs[index];
            if (!runs?.some((run) => run.k !== 'plain')) return;
            const emphasis: [number, number][] = [];
            let offset = 0;
            for (const span of row.spans) {
                if (span.e) emphasis.push([offset, offset + span.t.length]);
                offset += span.t.length;
            }
            const spans: DiffSpan[] = mergeSpans(row.text, runs, emphasis, row.type === 'add' ? 1 : 2);
            replacements.set(row, { ...row, spans });
        });
    }
    if (!replacements.size) return displayed;
    return displayed.map((row) => row.kind === 'line' ? replacements.get(row) ?? row : row);
}