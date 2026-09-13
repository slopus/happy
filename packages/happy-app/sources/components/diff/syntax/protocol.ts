import type { SyntaxRun } from '../engine/highlight';
import type { DiffRowType } from '../engine/types';

export const SYNTAX_REVEAL_MS = 1000;
export const MAX_SYNTAX_CHARACTERS = 128_000;
export const MAX_SYNTAX_LINE = 2000;
export const MAX_SYNTAX_LINES = 2000;
export const MAX_SYNTAX_RUNS = 20_000;

/** A contiguous hunk or code block (all ctx), never disconnected viewport lines. */
export interface SyntaxInput {
    language: string;
    lines: { text: string; type: DiffRowType }[];
}

export interface SyntaxResult {
    status: 'highlighted' | 'unsupported' | 'limited';
    runs: SyntaxRun[][];
    computeMs: number;
}

export interface SyntaxWorker {
    run(input: SyntaxInput): Promise<SyntaxResult>;
}

/** Infrastructure failure, as opposed to a bad input handled by a live worker. */
export class SyntaxWorkerUnavailableError extends Error {}

export function withinSyntaxLimits(input: SyntaxInput): boolean {
    if (input.lines.length > MAX_SYNTAX_LINES) return false;
    let characters = 0;
    for (const line of input.lines) {
        if (line.text.length > MAX_SYNTAX_LINE) return false;
        characters += line.text.length + 1;
        if (characters > MAX_SYNTAX_CHARACTERS) return false;
    }
    return true;
}