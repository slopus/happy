import { describe, expect, it } from 'vitest';
import { buildDiffFromContents, buildDiffFromPatch, clearDiffCache, mergeSpans } from './buildDiff';
import { parsePatch } from './parsePatch';
import { computeEmphasis, similarity, wordRanges } from './intraline';
import { highlightLines } from './highlight';
import { detectLanguage } from './language';
import { countPatchStats } from './stats';
import { generatePatch } from '../fixtures';
import type { DiffRow } from './types';

const lineRows = (rows: DiffRow[]) => rows.filter((r): r is Extract<DiffRow, { kind: 'line' }> => r.kind === 'line');
const textOf = (row: Extract<DiffRow, { kind: 'line' }>) => row.spans.map((s) => s.t).join('');

describe('parsePatch', () => {
    it('parses a plain modification', () => {
        const patch = [
            'diff --git a/src/app.ts b/src/app.ts',
            'index 1111111..2222222 100644',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,4 +1,4 @@ function main()',
            ' const a = 1;',
            '-const b = 2;',
            '+const b = 3;',
            ' const c = 4;',
        ].join('\n');

        const files = parsePatch(patch);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('src/app.ts');
        expect(files[0].kind).toBe('modified');
        expect(files[0].hunks[0].section).toBe('function main()');
        expect(files[0].hunks[0].lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'ctx']);
        expect(files[0].hunks[0].lines[1].oldNo).toBe(2);
        expect(files[0].hunks[0].lines[2].newNo).toBe(2);
    });

    it('recognizes added, deleted and renamed files', () => {
        const added = parsePatch([
            'diff --git a/new.txt b/new.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/new.txt',
            '@@ -0,0 +1,1 @@',
            '+hello',
        ].join('\n'));
        expect(added[0].kind).toBe('added');
        expect(added[0].path).toBe('new.txt');

        const deleted = parsePatch([
            'diff --git a/old.txt b/old.txt',
            'deleted file mode 100644',
            '--- a/old.txt',
            '+++ /dev/null',
            '@@ -1,1 +0,0 @@',
            '-bye',
        ].join('\n'));
        expect(deleted[0].kind).toBe('deleted');
        expect(deleted[0].path).toBe('old.txt');

        const renamed = parsePatch([
            'diff --git a/a.txt b/b.txt',
            'similarity index 90%',
            'rename from a.txt',
            'rename to b.txt',
            '@@ -1 +1 @@',
            '-one',
            '+two',
        ].join('\n'));
        expect(renamed[0].kind).toBe('renamed');
        expect(renamed[0].path).toBe('b.txt');
        expect(renamed[0].oldPath).toBe('a.txt');
    });

    it('parses multiple files in one patch', () => {
        const patch = [
            'diff --git a/one.ts b/one.ts',
            '--- a/one.ts',
            '+++ b/one.ts',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            'diff --git a/two.ts b/two.ts',
            '--- a/two.ts',
            '+++ b/two.ts',
            '@@ -1 +1 @@',
            '-c',
            '+d',
        ].join('\n');
        const files = parsePatch(patch);
        expect(files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
    });

    it('ignores the no-newline marker and blank context lines', () => {
        const patch = [
            '--- a/x.txt',
            '+++ b/x.txt',
            '@@ -1,3 +1,3 @@',
            ' one',
            '',
            '-two',
            '\\ No newline at end of file',
            '+three',
        ].join('\n');
        const lines = parsePatch(patch)[0].hunks[0].lines;
        expect(lines.map((l) => l.type)).toEqual(['ctx', 'ctx', 'del', 'add']);
        expect(lines[1].text).toBe('');
    });

    it('handles quoted paths', () => {
        const files = parsePatch([
            '--- "a/some dir/\\303\\251.ts"',
            '+++ "b/some dir/\\303\\251.ts"',
            '@@ -1 +1 @@',
            '-a',
            '+b',
        ].join('\n'));
        expect(files[0].path).toContain('some dir/');
    });
});

describe('intraline', () => {
    it('scores similarity by shared prefix and suffix', () => {
        expect(similarity('abc', 'abc')).toBe(1);
        expect(similarity('const a = 1;', 'const a = 2;')).toBeGreaterThan(0.8);
        expect(similarity('completely different', 'nothing alike here!!')).toBeLessThan(0.3);
    });

    it('marks only the changed words', () => {
        const { del, ins } = wordRanges('const value = 1;', 'const value = 2;');
        expect(del.map(([s, e]) => 'const value = 1;'.slice(s, e))).toEqual(['1']);
        expect(ins.map(([s, e]) => 'const value = 2;'.slice(s, e))).toEqual(['2']);
    });

    it('pairs removals with additions inside a block', () => {
        const emphasis = computeEmphasis([
            { type: 'ctx', text: 'keep' },
            { type: 'del', text: 'let x = 1;' },
            { type: 'del', text: 'let y = 2;' },
            { type: 'add', text: 'let x = 10;' },
            { type: 'add', text: 'let y = 20;' },
        ]);
        expect(emphasis.has(1)).toBe(true);
        expect(emphasis.has(3)).toBe(true);
        expect(emphasis.has(0)).toBe(false);
    });

    it('skips emphasis for unrelated lines', () => {
        const emphasis = computeEmphasis([
            { type: 'del', text: 'import fs from "fs";' },
            { type: 'add', text: 'export const answer = 42;' },
        ]);
        expect(emphasis.size).toBe(0);
    });
});

describe('highlightLines', () => {
    it('classifies typescript tokens', () => {
        const runs = highlightLines('const x = "hi"; // note', 'typescript');
        expect(runs).toHaveLength(1);
        expect(runs[0].map((r) => r.k)).toContain('keyword');
        expect(runs[0].map((r) => r.k)).toContain('string');
        expect(runs[0].map((r) => r.k)).toContain('comment');
    });

    it('keeps run lengths equal to the line length', () => {
        const source = 'function add(a: number, b: number) {\n    return a + b;\n}';
        const runs = highlightLines(source, 'typescript');
        const lines = source.split('\n');
        expect(runs).toHaveLength(lines.length);
        runs.forEach((line, i) => {
            const total = line.reduce((n, r) => n + r.n, 0);
            expect(total).toBe(lines[i].length);
        });
    });

    it('carries block comments across lines', () => {
        const runs = highlightLines('/* one\n   two */\ncode', 'javascript');
        expect(runs[1].every((r) => r.k === 'comment')).toBe(true);
        expect(runs[2].every((r) => r.k === 'comment')).toBe(false);
    });

    it('falls back to plain runs for unknown languages', () => {
        const runs = highlightLines('hello world', null);
        expect(runs[0]).toEqual([{ k: 'plain', n: 11 }]);
    });
});

describe('mergeSpans', () => {
    it('splits syntax runs at emphasis boundaries', () => {
        const text = 'const x = 1;';
        const spans = mergeSpans(text, [{ k: 'keyword', n: 5 }, { k: 'plain', n: 7 }], [[10, 11]], 1);
        expect(spans.map((s) => s.t).join('')).toBe(text);
        const emphasized = spans.filter((s) => s.e === 1);
        expect(emphasized.map((s) => s.t)).toEqual(['1']);
    });

    it('preserves the full text with no emphasis', () => {
        const text = 'abcdef';
        const spans = mergeSpans(text, [{ k: 'plain', n: 3 }, { k: 'string', n: 3 }], undefined, 2);
        expect(spans.map((s) => s.t).join('')).toBe(text);
        expect(spans).toHaveLength(2);
    });

    it('returns nothing for an empty line', () => {
        expect(mergeSpans('', [], undefined, 1)).toEqual([]);
    });
});

describe('buildDiffFromPatch', () => {
    it('produces rows whose spans reconstruct the source lines', () => {
        clearDiffCache();
        const patch = [
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,4 +1,4 @@',
            ' import { a } from "./a";',
            '-const value = 1;',
            '+const value = 2;',
            ' export default value;',
        ].join('\n');

        const doc = buildDiffFromPatch(patch);
        expect(doc.files).toHaveLength(1);
        const file = doc.files[0];
        expect(file.language).toBe('typescript');
        expect(file.additions).toBe(1);
        expect(file.deletions).toBe(1);

        const rows = lineRows(file.rows);
        expect(rows).toHaveLength(4);
        rows.forEach((row) => expect(textOf(row)).toBe(row.text));

        const added = rows.find((r) => r.type === 'add')!;
        expect(added.spans.some((s) => s.e === 1)).toBe(true);
        const removed = rows.find((r) => r.type === 'del')!;
        expect(removed.spans.some((s) => s.e === 2)).toBe(true);
    });

    it('expands tabs so column math is exact', () => {
        const patch = [
            '--- a/x.go',
            '+++ b/x.go',
            '@@ -1 +1 @@',
            '-\tfmt.Println("a")',
            '+\tfmt.Println("b")',
        ].join('\n');
        const file = buildDiffFromPatch(patch, { tabWidth: 4 }).files[0];
        const rows = lineRows(file.rows);
        expect(rows[0].text.startsWith('    fmt')).toBe(true);
        expect(file.maxColumns).toBe(rows[0].text.length);
    });

    it('records the widest line number for gutter sizing', () => {
        const patch = [
            '--- a/x.txt',
            '+++ b/x.txt',
            '@@ -1198,2 +1198,2 @@',
            '-a',
            '+b',
        ].join('\n');
        expect(buildDiffFromPatch(patch).files[0].maxLineNo).toBe(1198);
    });

    it('emits a hunk row before each hunk with the hidden line count', () => {
        const patch = [
            '--- a/x.txt',
            '+++ b/x.txt',
            '@@ -10,2 +10,2 @@',
            '-a',
            '+b',
            '@@ -40,2 +40,2 @@',
            '-c',
            '+d',
        ].join('\n');
        const rows = buildDiffFromPatch(patch).files[0].rows;
        const hunks = rows.filter((r) => r.kind === 'hunk') as Extract<DiffRow, { kind: 'hunk' }>[];
        expect(hunks).toHaveLength(2);
        expect(hunks[0].hidden).toBe(9);
        expect(hunks[1].hidden).toBe(28);
    });

    it('reports binary files instead of rendering them', () => {
        const doc = buildDiffFromPatch([
            'diff --git a/logo.png b/logo.png',
            'index 1111111..2222222 100644',
            'Binary files a/logo.png and b/logo.png differ',
        ].join('\n'));
        expect(doc.files[0].kind).toBe('binary');
        expect(doc.files[0].rows[0]).toMatchObject({ kind: 'message' });
    });

    it('serves repeat builds from cache', () => {
        clearDiffCache();
        const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-1', '+2'].join('\n');
        const first = buildDiffFromPatch(patch);
        const second = buildDiffFromPatch(patch);
        expect(second).toBe(first);
        clearDiffCache();
        expect(buildDiffFromPatch(patch)).not.toBe(first);
    });

    it('drops syntax and word diff for very large files', () => {
        const body = Array.from({ length: 40 }, (_, i) => ` line ${i}`);
        const patch = ['--- a/big.ts', '+++ b/big.ts', '@@ -1,40 +1,40 @@', ...body, '-const a = 1;', '+const a = 2;'].join('\n');
        const file = buildDiffFromPatch(patch, { maxHighlightLines: 10 }).files[0];
        const rows = lineRows(file.rows);
        expect(rows.every((r) => r.spans.every((s) => s.k === 'plain' && s.e === 0))).toBe(true);
    });

    it('still highlights when options carry undefined fields', () => {
        // Regression: a spread merge let `{ syntax: undefined }` overwrite the
        // default and silently disabled highlighting for every hook caller.
        clearDiffCache();
        const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-const a = 1;', '+const a = 2;'].join('\n');
        const file = buildDiffFromPatch(patch, { syntax: undefined, intraline: undefined, contextLines: undefined }).files[0];
        const rows = lineRows(file.rows);
        expect(rows.some((r) => r.spans.some((s) => s.k === 'keyword'))).toBe(true);
        expect(rows.some((r) => r.spans.some((s) => s.e !== 0))).toBe(true);
    });

    it('tolerates junk input', () => {
        expect(buildDiffFromPatch('').files).toEqual([]);
        expect(buildDiffFromPatch('not a patch at all').files).toEqual([]);
        expect(() => buildDiffFromPatch('@@ malformed @@\n+x')).not.toThrow();
    });
});

describe('buildDiffFromContents', () => {
    it('diffs two blobs with context', () => {
        const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        const newText = oldText.replace('line 10', 'line ten');
        const file = buildDiffFromContents('sample.txt', oldText, newText, { contextLines: 2 }).files[0];
        const rows = lineRows(file.rows);
        // 2 context + change pair + 2 context.
        expect(rows).toHaveLength(6);
        expect(rows.filter((r) => r.type === 'add')).toHaveLength(1);
        expect(rows.filter((r) => r.type === 'del')).toHaveLength(1);
    });

    it('treats empty old text as a new file', () => {
        const doc = buildDiffFromContents('new.ts', '', 'const a = 1;\n');
        expect(doc.files[0].kind).toBe('added');
        expect(doc.files[0].additions).toBe(1);
    });

    it('reports no rows when nothing changed', () => {
        const doc = buildDiffFromContents('same.ts', 'a\nb\n', 'a\nb\n');
        expect(doc.files[0].rows).toEqual([{ kind: 'message', key: 'empty', code: 'empty' }]);
    });
});

describe('countPatchStats', () => {
    it('counts changed lines without building anything', () => {
        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,3 +1,4 @@',
            ' ctx',
            '-gone',
            '+added',
            '+added too',
            'diff --git a/b.ts b/b.ts',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1 +1 @@',
            '-x',
            '+y',
        ].join('\n');
        expect(countPatchStats(patch)).toEqual({ additions: 3, deletions: 2 });
    });

    it('agrees with the built document', () => {
        const patch = generatePatch(3, 120);
        const doc = buildDiffFromPatch(patch);
        expect(countPatchStats(patch)).toEqual({ additions: doc.additions, deletions: doc.deletions });
    });
});

describe('detectLanguage', () => {
    it('maps common extensions and file names', () => {
        expect(detectLanguage('sources/app.tsx')).toBe('tsx');
        expect(detectLanguage('main.py')).toBe('python');
        expect(detectLanguage('Dockerfile')).toBe('docker');
        expect(detectLanguage('Makefile')).toBe('makefile');
        expect(detectLanguage('data.unknownext')).toBe(null);
        expect(detectLanguage(null)).toBe(null);
    });
});
