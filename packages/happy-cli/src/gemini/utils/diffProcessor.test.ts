import { describe, it, expect, vi } from 'vitest';
import { summarizeUnifiedDiff, GeminiDiffProcessor } from './diffProcessor';

vi.mock('@/modules/common/diffStore', () => ({ saveDiffRecords: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

describe('summarizeUnifiedDiff', () => {
    it('returns empty results for empty string', () => {
        const result = summarizeUnifiedDiff('');
        expect(result.files).toEqual([]);
        expect(result.stats).toEqual({ additions: 0, deletions: 0 });
        expect(result.fileStats).toEqual({});
    });

    it('parses single-file diff', () => {
        const diff = [
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,3 +1,3 @@',
            ' line1',
            '-old',
            '+new',
            ' line3',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['src/app.ts']);
        expect(result.stats).toEqual({ additions: 1, deletions: 1 });
        expect(result.fileStats).toEqual({
            'src/app.ts': { additions: 1, deletions: 1 },
        });
    });

    it('computes correct per-file stats for multi-file diff', () => {
        const diff = [
            '--- a/file1.ts',
            '+++ b/file1.ts',
            '@@ -1,2 +1,3 @@',
            ' keep',
            '+added1',
            '+added2',
            '--- a/file2.ts',
            '+++ b/file2.ts',
            '@@ -1,3 +1,1 @@',
            ' keep',
            '-removed1',
            '-removed2',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['file1.ts', 'file2.ts']);
        expect(result.stats).toEqual({ additions: 2, deletions: 2 });
        expect(result.fileStats).toEqual({
            'file1.ts': { additions: 2, deletions: 0 },
            'file2.ts': { additions: 0, deletions: 2 },
        });
    });

    it('handles deleted file (+++ /dev/null) using --- a/ fallback', () => {
        const diff = [
            '--- a/old.ts',
            '+++ /dev/null',
            '@@ -1,3 +0,0 @@',
            '-line1',
            '-line2',
            '-line3',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['old.ts']);
        expect(result.stats).toEqual({ additions: 0, deletions: 3 });
        expect(result.fileStats).toEqual({
            'old.ts': { additions: 0, deletions: 3 },
        });
    });

    it('handles new file (--- /dev/null)', () => {
        const diff = [
            '--- /dev/null',
            '+++ b/new.ts',
            '@@ -0,0 +1,2 @@',
            '+line1',
            '+line2',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['new.ts']);
        expect(result.stats).toEqual({ additions: 2, deletions: 0 });
        expect(result.fileStats).toEqual({
            'new.ts': { additions: 2, deletions: 0 },
        });
    });

    it('handles mixed add/delete/modify across files', () => {
        const diff = [
            '--- a/modified.ts',
            '+++ b/modified.ts',
            '@@ -1,3 +1,4 @@',
            ' keep',
            '-old1',
            '-old2',
            '+new1',
            '+new2',
            '+new3',
            '--- a/deleted.ts',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-gone1',
            '-gone2',
            '--- /dev/null',
            '+++ b/created.ts',
            '@@ -0,0 +1,1 @@',
            '+hello',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['modified.ts', 'deleted.ts', 'created.ts']);
        expect(result.stats).toEqual({ additions: 4, deletions: 4 });
        expect(result.fileStats).toEqual({
            'modified.ts': { additions: 3, deletions: 2 },
            'deleted.ts': { additions: 0, deletions: 2 },
            'created.ts': { additions: 1, deletions: 0 },
        });
    });

    it('does not duplicate files in the list', () => {
        const diff = [
            '--- a/same.ts',
            '+++ b/same.ts',
            '@@ -1 +1 @@',
            '-a',
            '+b',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        expect(result.files).toEqual(['same.ts']);
    });

    it('aggregate stats equal sum of per-file stats', () => {
        const diff = [
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,2 +1,3 @@',
            ' x',
            '-old',
            '+new1',
            '+new2',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,4 +1,2 @@',
            ' x',
            '-r1',
            '-r2',
            '-r3',
            '+kept',
        ].join('\n');

        const result = summarizeUnifiedDiff(diff);
        const sumAdd = Object.values(result.fileStats).reduce((s, f) => s + f.additions, 0);
        const sumDel = Object.values(result.fileStats).reduce((s, f) => s + f.deletions, 0);
        expect(result.stats.additions).toBe(sumAdd);
        expect(result.stats.deletions).toBe(sumDel);
    });
});

describe('GeminiDiffProcessor.processFsEdit → emitted toolCall', () => {
    it('emits toolCall with correct fileStats for multi-file diff', () => {
        const messages: any[] = [];
        const processor = new GeminiDiffProcessor((msg) => messages.push(msg));

        const diff = [
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,3 @@',
            ' keep',
            '-old',
            '+new1',
            '+new2',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1,3 +1,1 @@',
            ' keep',
            '-r1',
            '-r2',
        ].join('\n');

        processor.processFsEdit('src/a.ts', 'test edit', diff);

        // Should emit tool-call then tool-call-result
        expect(messages).toHaveLength(2);
        const toolCall = messages[0];
        expect(toolCall.type).toBe('tool-call');
        expect(toolCall.name).toBe('GeminiDiff');
        expect(toolCall.input.files).toContain('src/a.ts');
        expect(toolCall.input.files).toContain('src/b.ts');
        expect(toolCall.input.stats).toEqual({ additions: 2, deletions: 3 });
        expect(toolCall.input.fileStats).toEqual({
            'src/a.ts': { additions: 2, deletions: 1 },
            'src/b.ts': { additions: 0, deletions: 2 },
        });
    });
});
