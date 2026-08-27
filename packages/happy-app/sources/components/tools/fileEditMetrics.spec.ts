import { describe, expect, it } from 'vitest';
import {
    getFileEditDiffMetrics,
    LARGE_EDIT_CHANGED_LINES,
} from './fileEditMetrics';

describe('file edit diff metrics', () => {
    it('counts changed lines for an old/new content pair', () => {
        const metrics = getFileEditDiffMetrics([{
            oldText: 'a\nb\nc',
            newText: 'a\nB\nc\nd',
        }]);
        expect(metrics.additions).toBeGreaterThan(0);
        expect(metrics.deletions).toBeGreaterThan(0);
        expect(metrics.changedLines).toBe(metrics.additions + metrics.deletions);
    });

    it('counts changed lines from a unified patch', () => {
        const patch = [
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,3 +1,3 @@',
            ' context',
            '-old line',
            '+new line',
        ].join('\n');
        expect(getFileEditDiffMetrics([{ patch }])).toEqual({
            additions: 1,
            deletions: 1,
            changedLines: 2,
        });
    });

    it('sums across multiple hunks so MultiEdit collapses on total size', () => {
        const hunk = { oldText: 'one', newText: 'two' };
        const single = getFileEditDiffMetrics([hunk]);
        const double = getFileEditDiffMetrics([hunk, hunk]);
        expect(double.changedLines).toBe(single.changedLines * 2);
    });

    it('keeps a small edit under the collapse threshold and a large one over it', () => {
        const small = getFileEditDiffMetrics([{ oldText: 'a', newText: 'b' }]);
        expect(small.changedLines).toBeLessThanOrEqual(LARGE_EDIT_CHANGED_LINES);

        const oldLines = Array.from({ length: 60 }, (_, i) => `old line ${i}`).join('\n');
        const newLines = Array.from({ length: 60 }, (_, i) => `new line ${i}`).join('\n');
        const large = getFileEditDiffMetrics([{ oldText: oldLines, newText: newLines }]);
        expect(large.changedLines).toBeGreaterThan(LARGE_EDIT_CHANGED_LINES);
    });
});
