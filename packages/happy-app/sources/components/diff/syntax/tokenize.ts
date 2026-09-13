/** Worker-only entry. This module and its dependencies contain no React/DOM APIs. */
import { hasGrammar, highlightLines, type SyntaxRun } from '../engine/highlight';
import { MAX_SYNTAX_RUNS, SYNTAX_REVEAL_MS, withinSyntaxLimits, type SyntaxInput, type SyntaxResult } from './protocol';

export function tokenize(input: SyntaxInput): SyntaxResult {
    const started = performance.now();
    const finish = (status: SyntaxResult['status'], runs: SyntaxRun[][] = []): SyntaxResult => ({
        status, runs, computeMs: performance.now() - started,
    });
    if (!withinSyntaxLimits(input)) return finish('limited');
    if (!hasGrammar(input.language)) return finish('unsupported');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of input.lines) {
        if (line.type !== 'add') oldLines.push(line.text);
        if (line.type !== 'del') newLines.push(line.text);
    }
    const oldRuns = oldLines.length ? highlightLines(oldLines.join('\n'), input.language) : [];
    // Prism is synchronous. This check prevents starting MORE work after the
    // budget, not interrupting a regex already running. The RN deadline is
    // independent, and the queue never spawns replacement native runtimes.
    if (performance.now() - started >= SYNTAX_REVEAL_MS) return finish('limited');
    // Plain code/terminal blocks have identical sides. Tokenize only once.
    const unchanged = input.lines.every((line) => line.type === 'ctx');
    const newRuns = unchanged ? oldRuns : newLines.length ? highlightLines(newLines.join('\n'), input.language) : [];
    if (performance.now() - started >= SYNTAX_REVEAL_MS) return finish('limited');
    let oldIndex = 0;
    let newIndex = 0;
    let runCount = 0;
    const runs = input.lines.map((line) => {
        const old = line.type !== 'add' ? oldRuns[oldIndex++] : undefined;
        const next = line.type !== 'del' ? newRuns[newIndex++] : undefined;
        const result = next ?? old ?? [];
        runCount += result.length;
        return result;
    });
    return runCount > MAX_SYNTAX_RUNS ? finish('limited') : finish('highlighted', runs);
}