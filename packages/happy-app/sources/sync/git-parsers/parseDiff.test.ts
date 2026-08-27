import { describe, expect, it } from 'vitest';
import { parseUntrackedLineCounts } from './parseDiff';

describe('parseUntrackedLineCounts', () => {
    it('sums per-file counts and skips batch totals', () => {
        const output = [
            '      12 src/lib/notes.ts',
            '     130 src/app/page.tsx',
            '     142 total',
        ].join('\n');
        expect(parseUntrackedLineCounts(output)).toBe(142);
    });

    it('handles the single-file form, where wc prints no total', () => {
        expect(parseUntrackedLineCounts('      12 src/lib/notes.ts\n')).toBe(12);
    });

    it('sums across several xargs batches', () => {
        const output = [
            '      10 a.ts',
            '      10 total',
            '       5 b.ts',
            '       5 total',
        ].join('\n');
        expect(parseUntrackedLineCounts(output)).toBe(15);
    });

    it('ignores binary files, whose newline counts mean nothing', () => {
        const output = [
            '      40 src/app.tsx',
            '     900 assets/logo.png',
            '     940 total',
        ].join('\n');
        expect(parseUntrackedLineCounts(output)).toBe(40);
    });

    it('returns zero when the command produced nothing usable', () => {
        expect(parseUntrackedLineCounts('')).toBe(0);
        // `wc` reading empty stdin, i.e. no untracked files at all.
        expect(parseUntrackedLineCounts('       0\n')).toBe(0);
        expect(parseUntrackedLineCounts('xargs: command not found')).toBe(0);
    });

    it('keeps paths that merely contain spaces or look like a total', () => {
        expect(parseUntrackedLineCounts('       7 docs/my total notes.md\n')).toBe(7);
    });
});
