import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './codexUnifiedDiff';

describe('parseUnifiedDiff', () => {
    it('parses unified diff hunk fragments without file headers', () => {
        const parsed = parseUnifiedDiff(
            [
                '@@ -10,2 +10,4 @@',
                ' ',
                '+<p align="center"><em>Still won\'t make your tests pass by the power of positive thinking.</em></p>',
                '+',
                ' <div align="center">',
            ].join('\n'),
        );

        expect(parsed.fileName).toBeUndefined();
        expect(parsed.oldText).toBe('\n<div align="center">');
        expect(parsed.newText).toBe([
            '',
            '<p align="center"><em>Still won\'t make your tests pass by the power of positive thinking.</em></p>',
            '',
            '<div align="center">',
        ].join('\n'));
    });

    it('extracts filenames from full unified diffs', () => {
        const parsed = parseUnifiedDiff(
            [
                'diff --git a/README.md b/README.md',
                'index 1111111..2222222 100644',
                '--- a/README.md',
                '+++ b/README.md',
                '@@ -1 +1 @@',
                '-old line',
                '+new line',
            ].join('\n'),
        );

        expect(parsed.fileName).toBe('README.md');
        expect(parsed.oldText).toBe('old line');
        expect(parsed.newText).toBe('new line');
    });
});
