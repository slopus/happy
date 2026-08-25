/**
 * Headless build benchmark: `DIFF_BENCH=1 npx vitest run sources/components/diff/engine/benchmark.spec.ts`
 *
 * Measures only the CPU half of the renderer (parse, syntax, word diff, span
 * merge) — the half that runs on the JS thread and therefore the half that
 * stalls a scroll. Rendering cost is measured on device via the dev page at
 * /dev/diff-bench.
 */

import { buildDiffFromPatch, clearDiffCache } from './buildDiff';
import { generatePatch } from '../fixtures';

interface Case {
    label: string;
    files: number;
    lines: number;
}

const CASES: Case[] = [
    { label: 'chat edit    (1 file,  40 lines)', files: 1, lines: 40 },
    { label: 'file         (1 file, 400 lines)', files: 1, lines: 400 },
    { label: 'big file     (1 file,  4k lines)', files: 1, lines: 4000 },
    { label: 'PR          (12 files, 300 lines)', files: 12, lines: 300 },
    { label: 'huge PR     (60 files, 600 lines)', files: 60, lines: 600 },
];

const REPEATS = 5;

function measure(fn: () => void): number {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

export function runDiffBenchmark(): void {
    console.log('diff engine build cost\n');
    console.log(
        'case'.padEnd(36),
        'rows'.padStart(7),
        'full'.padStart(9),
        'no-syntax'.padStart(11),
        'plain'.padStart(9),
        'cached'.padStart(9),
    );

    for (const testCase of CASES) {
        const patch = generatePatch(testCase.files, testCase.lines);

        const timed = (options: Parameters<typeof buildDiffFromPatch>[1]) =>
            median(Array.from({ length: REPEATS }, () => {
                clearDiffCache();
                return measure(() => buildDiffFromPatch(patch, options));
            }));

        clearDiffCache();
        const doc = buildDiffFromPatch(patch);
        const rows = doc.files.reduce((n, f) => n + f.rows.length, 0);

        const full = timed(undefined);
        const noSyntax = timed({ syntax: false });
        const plain = timed({ syntax: false, intraline: false });
        const cached = median(Array.from({ length: REPEATS }, () => measure(() => buildDiffFromPatch(patch))));

        console.log(
            testCase.label.padEnd(36),
            String(rows).padStart(7),
            `${full.toFixed(1)}ms`.padStart(9),
            `${noSyntax.toFixed(1)}ms`.padStart(11),
            `${plain.toFixed(1)}ms`.padStart(9),
            `${cached.toFixed(2)}ms`.padStart(9),
        );
    }

    console.log('\nBudget: anything under ~16ms builds inside a single frame.');
}
