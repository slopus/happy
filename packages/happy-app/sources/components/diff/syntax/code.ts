import type { DiffSpan } from '../engine/types';
import { MAX_SYNTAX_CHARACTERS, MAX_SYNTAX_LINES, withinSyntaxLimits, type SyntaxInput } from './protocol';
import { syntaxKey, type SyntaxOutcome } from './service';
import type { PlannedSyntax } from './useSyntaxRequests';

/** Bound native Text children as well as worker time for a non-virtualized block. */
export const MAX_CODE_SYNTAX_SPANS = 2000;
type CodeSpan = Pick<DiffSpan, 't' | 'k'>;

export function planCodeSyntax(code: string, language: string | null): PlannedSyntax[] {
    if (!language || !code || code.length > MAX_SYNTAX_CHARACTERS) return [];
    // Limit splitting before allocating line objects, including newline-heavy
    // output that is under the character cap but far above the line cap.
    const lines = code.split('\n', MAX_SYNTAX_LINES + 1);
    if (lines.length > MAX_SYNTAX_LINES) return [];
    const input: SyntaxInput = { language, lines: lines.map((text) => ({ text, type: 'ctx' })) };
    if (!withinSyntaxLimits(input)) return [];
    return [{ key: syntaxKey(input), input }];
}

/** Join adjacent colors across line breaks; never normalize the original text. */
export function codeSyntaxSpans(input: SyntaxInput, outcome: SyntaxOutcome | undefined): CodeSpan[] | null {
    if (outcome?.status !== 'highlighted' || !outcome.result) return null;
    const spans: CodeSpan[] = [];
    const append = (t: string, k: DiffSpan['k']) => {
        if (!t) return;
        const last = spans[spans.length - 1];
        if (last?.k === k) last.t += t;
        else spans.push({ t, k });
    };
    for (let index = 0; index < input.lines.length; index++) {
        const text = input.lines[index].text;
        let offset = 0;
        for (const run of outcome.result.runs[index] ?? []) {
            append(text.slice(offset, offset + run.n), run.k);
            offset += run.n;
            if (spans.length > MAX_CODE_SYNTAX_SPANS) return null;
        }
        append(text.slice(offset), 'plain');
        if (index < input.lines.length - 1) append('\n', 'plain');
        if (spans.length > MAX_CODE_SYNTAX_SPANS) return null;
    }
    return spans.some((span) => span.k !== 'plain') ? spans : null;
}