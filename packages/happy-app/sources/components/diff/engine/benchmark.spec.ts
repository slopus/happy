import { describe, expect, it } from 'vitest';
import { runDiffBenchmark } from './benchmark';
import { buildDiffFromPatch, clearDiffCache } from './buildDiff';
import { generatePatch } from '../fixtures';

/**
 * The table is opt-in (`DIFF_BENCH=1`) because it takes a few seconds; the
 * regression guard below always runs and fails if building a typical chat-sized
 * edit ever stops fitting comfortably inside one frame.
 */
describe('diff engine performance', () => {
    it.runIf(process.env.DIFF_BENCH === '1')('prints the build cost table', () => {
        runDiffBenchmark();
    }, 120_000);

    it('builds a chat-sized edit well inside a frame budget', () => {
        const patch = generatePatch(1, 60);
        // Warm the grammar cache; the first tokenize of a language pays for the
        // Prism component module, which is a one-off per app run.
        buildDiffFromPatch(patch);

        const samples: number[] = [];
        for (let i = 0; i < 20; i++) {
            clearDiffCache();
            const t0 = performance.now();
            buildDiffFromPatch(patch);
            samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        expect(median).toBeLessThan(16);
    });

    it('returns cached documents instantly', () => {
        const patch = generatePatch(4, 200);
        buildDiffFromPatch(patch);
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) buildDiffFromPatch(patch);
        expect((performance.now() - t0) / 50).toBeLessThan(1);
    });
});
