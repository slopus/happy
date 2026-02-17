import { describe, it, expect, vi } from 'vitest';
import { splitUnifiedDiff, DiffProcessor } from './diffProcessor';

vi.mock('@/modules/common/diffStore', () => ({ saveDiffRecords: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

describe('splitUnifiedDiff', () => {
    it('returns empty array for empty string', () => {
        expect(splitUnifiedDiff('')).toEqual([]);
    });

    it('parses single-file diff', () => {
        const diff = [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,3 +1,3 @@',
            ' line1',
            '-old',
            '+new',
            ' line3',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result).toHaveLength(1);
        expect(result[0].filePath).toBe('src/app.ts');
        expect(result[0].additions).toBe(1);
        expect(result[0].deletions).toBe(1);
        expect(result[0].diff).toContain('-old');
        expect(result[0].diff).toContain('+new');
    });

    it('parses multi-file diff with correct per-file stats', () => {
        const diff = [
            'diff --git a/file1.ts b/file1.ts',
            '--- a/file1.ts',
            '+++ b/file1.ts',
            '@@ -1,2 +1,3 @@',
            ' keep',
            '+added1',
            '+added2',
            'diff --git a/file2.ts b/file2.ts',
            '--- a/file2.ts',
            '+++ b/file2.ts',
            '@@ -1,3 +1,1 @@',
            ' keep',
            '-removed1',
            '-removed2',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result).toHaveLength(2);

        expect(result[0].filePath).toBe('file1.ts');
        expect(result[0].additions).toBe(2);
        expect(result[0].deletions).toBe(0);

        expect(result[1].filePath).toBe('file2.ts');
        expect(result[1].additions).toBe(0);
        expect(result[1].deletions).toBe(2);
    });

    it('handles deleted file (+++ /dev/null) using --- a/ fallback', () => {
        const diff = [
            'diff --git a/old.ts b/old.ts',
            '--- a/old.ts',
            '+++ /dev/null',
            '@@ -1,3 +0,0 @@',
            '-line1',
            '-line2',
            '-line3',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result).toHaveLength(1);
        expect(result[0].filePath).toBe('old.ts');
        expect(result[0].additions).toBe(0);
        expect(result[0].deletions).toBe(3);
    });

    it('handles new file (--- /dev/null)', () => {
        const diff = [
            'diff --git a/new.ts b/new.ts',
            '--- /dev/null',
            '+++ b/new.ts',
            '@@ -0,0 +1,2 @@',
            '+line1',
            '+line2',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result).toHaveLength(1);
        expect(result[0].filePath).toBe('new.ts');
        expect(result[0].additions).toBe(2);
        expect(result[0].deletions).toBe(0);
    });

    it('preserves full diff content per file', () => {
        const diff = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result[0].diff).toBe(diff);
    });

    it('handles mixed add/delete/modify across files', () => {
        const diff = [
            'diff --git a/modified.ts b/modified.ts',
            '--- a/modified.ts',
            '+++ b/modified.ts',
            '@@ -1,3 +1,4 @@',
            ' keep',
            '-old1',
            '-old2',
            '+new1',
            '+new2',
            '+new3',
            'diff --git a/deleted.ts b/deleted.ts',
            '--- a/deleted.ts',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-gone1',
            '-gone2',
            'diff --git a/created.ts b/created.ts',
            '--- /dev/null',
            '+++ b/created.ts',
            '@@ -0,0 +1,1 @@',
            '+hello',
        ].join('\n');

        const result = splitUnifiedDiff(diff);
        expect(result).toHaveLength(3);

        // modified: -2 +3
        expect(result[0].filePath).toBe('modified.ts');
        expect(result[0].additions).toBe(3);
        expect(result[0].deletions).toBe(2);

        // deleted: -2 +0
        expect(result[1].filePath).toBe('deleted.ts');
        expect(result[1].additions).toBe(0);
        expect(result[1].deletions).toBe(2);

        // created: -0 +1
        expect(result[2].filePath).toBe('created.ts');
        expect(result[2].additions).toBe(1);
        expect(result[2].deletions).toBe(0);
    });
});

describe('DiffProcessor.processDiff → emitted toolCall', () => {
    it('emits toolCall with correct fileStats for multi-file diff', () => {
        const messages: any[] = [];
        const processor = new DiffProcessor((msg) => messages.push(msg));

        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,3 @@',
            ' keep',
            '-old',
            '+new1',
            '+new2',
            'diff --git a/src/b.ts b/src/b.ts',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1,3 +1,1 @@',
            ' keep',
            '-r1',
            '-r2',
        ].join('\n');

        processor.processDiff(diff);

        // Should emit tool-call then tool-call-result
        expect(messages).toHaveLength(2);
        const toolCall = messages[0];
        expect(toolCall.type).toBe('tool-call');
        expect(toolCall.name).toBe('CodexDiff');
        expect(toolCall.input.files).toEqual(['src/a.ts', 'src/b.ts']);
        expect(toolCall.input.stats).toEqual({ additions: 2, deletions: 3 });
        expect(toolCall.input.fileStats).toEqual({
            'src/a.ts': { additions: 2, deletions: 1 },
            'src/b.ts': { additions: 0, deletions: 2 },
        });
    });
});
