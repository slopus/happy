#!/usr/bin/env node --experimental-transform-types
// Generates the diff engine's reference fixtures in
// Tests/HappyCoreTests/Fixtures:
//
// - jsdiff-vectors.json: jsdiff's own answers for word, line and array
//   diffs over code-like text with tabs, CRLF, accents and emoji, plus
//   budgeted line diffs that give up. HappyCore's MyersDiff ports jsdiff.
// - diff-engine-vectors.json: what happy-app's diff engine
//   (sources/components/diff/engine) makes of patches and blob pairs:
//   parsed files, built documents with every row and span, and the stats.
//   The engine runs here as TypeScript, straight from happy-app's sources.
//
// DiffEngineTests checks the Swift port gives exactly the same answers.
//
// Usage (from the repo root, after `pnpm install`):
//   node --experimental-transform-types packages/happy-ios/scripts/generate-diff-vectors.mjs
// To use node_modules from somewhere else (they need `diff` and `prismjs`;
// the vectors were made with diff 8.0.3):
//   DIFF_NODE_MODULES=/path/to/node_modules node --experimental-transform-types .../generate-diff-vectors.mjs
//
// Output is deterministic: the cases come from a seeded generator.

import { createRequire, register } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const nodeModules = process.env.DIFF_NODE_MODULES ?? path.join(repoRoot, 'packages/happy-app/node_modules');
const require = createRequire(path.join(nodeModules, 'package.json'));
const { diffLines, diffWordsWithSpace, diffArrays, createTwoFilesPatch } = require('diff');
const { version } = require('diff/package.json');
const fixtures = path.join(here, '../Tests/HappyCoreTests/Fixtures');

// happy-app's engine imports its siblings without extensions, `diff` as a
// bare module, and loads Prism through `require`.
const diffEntry = pathToFileURL(path.join(path.dirname(require.resolve('diff/package.json')), 'libesm/index.js')).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === 'diff') return next(${JSON.stringify(diffEntry)}, context);
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
}`));
globalThis.require = require;
const engineDir = path.join(repoRoot, 'packages/happy-app/sources/components/diff/engine');
const { buildDiffFromPatch, buildDiffFromContents, clearDiffCache } = await import(pathToFileURL(path.join(engineDir, 'buildDiff.ts')).href);
const { parsePatch } = await import(pathToFileURL(path.join(engineDir, 'parsePatch.ts')).href);
const { countPatchStats, countContentStats } = await import(pathToFileURL(path.join(engineDir, 'stats.ts')).href);

const write = (name, generator, cases) => {
    writeFileSync(
        path.join(fixtures, name),
        `{"generator":"scripts/generate-diff-vectors.mjs, ${generator}","cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
    );
    console.log(name, cases.length, 'cases');
};

let seed = 20261013;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const words = ['const', 'let', 'value', 'x', 'foo_bar', '42', 'café', 'naïve', 'Ünïcödé', '😀', 'e\u0301', '=', '(', ')', ';', '.', ',', '{', '}', '"str"', '->', 'ẞig'];
const spaces = [' ', ' ', '  ', '\t', '\u00a0', ' \t '];
function line() {
    const n = 1 + Math.floor(rand() * 8);
    let out = rand() < 0.3 ? pick(spaces) : '';
    for (let i = 0; i < n; i++) {
        out += pick(words);
        if (rand() < 0.6) out += pick(spaces);
    }
    return out;
}
function mutate(text) {
    const tokens = text.match(/\S+|\s+/g) ?? [];
    const edits = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < edits; i++) {
        const at = Math.floor(rand() * (tokens.length + 1));
        const op = rand();
        if (op < 0.33) tokens.splice(at, 1);
        else if (op < 0.66) tokens.splice(at, 0, pick(words));
        else tokens.splice(at, 1, pick(words));
    }
    return tokens.join('');
}
const pool = ['alpha', 'beta', 'gamma', '', '  indented', 'delta\r', 'épsilon', 'zeta 😀', '\tz'];
function text() {
    const n = Math.floor(rand() * 12);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(pick(pool));
    const sep = rand() < 0.2 ? '\r\n' : '\n';
    let out = lines.join(sep);
    if (n > 0 && rand() < 0.6) out += sep;
    return out;
}
function mutateText(t) {
    const lines = t.split('\n');
    const edits = Math.floor(rand() * 4);
    for (let i = 0; i < edits; i++) {
        const at = Math.floor(rand() * (lines.length + 1));
        const op = rand();
        if (op < 0.33) lines.splice(at, 1);
        else if (op < 0.66) lines.splice(at, 0, pick(pool));
        else lines.splice(at, 1, pick(pool));
    }
    return lines.join('\n');
}
const clean = (changes) => changes === undefined ? null : changes.map((c) => ({ value: c.value, count: c.count, added: c.added, removed: c.removed }));

const cases = [];
for (let i = 0; i < 150; i++) {
    const a = line();
    const b = rand() < 0.15 ? line() : mutate(a);
    cases.push({ kind: 'words', old: a, new: b, expected: clean(diffWordsWithSpace(a, b)) });
}
cases.push({ kind: 'words', old: 'a\r\nb\rc', new: 'a\nb\r\nc', expected: clean(diffWordsWithSpace('a\r\nb\rc', 'a\nb\r\nc')) });
cases.push({ kind: 'words', old: '', new: 'x y', expected: clean(diffWordsWithSpace('', 'x y')) });
for (let i = 0; i < 150; i++) {
    const a = text();
    const b = rand() < 0.15 ? text() : mutateText(a);
    cases.push({ kind: 'lines', old: a, new: b, expected: clean(diffLines(a, b)) });
}
for (let i = 0; i < 40; i++) {
    const a = text();
    const b = mutateText(a);
    const maxEditLength = Math.floor(rand() * 4);
    cases.push({ kind: 'lines', old: a, new: b, maxEditLength, expected: clean(diffLines(a, b, { maxEditLength })) });
}
const strip = (s) => s.replace(/\s/g, '');
for (let i = 0; i < 60; i++) {
    const a = text().split('\n');
    const b = mutateText(a.join('\n')).split('\n').map((l) => rand() < 0.3 ? ' ' + l + '\t' : l);
    cases.push({ kind: 'arrays', old: a, new: b, expected: clean(diffArrays(a, b, { comparator: (l, r) => strip(l) === strip(r) })) });
}

write('jsdiff-vectors.json', `jsdiff ${version}`, cases);

// ── The engine ─────────────────────────────────────────────────────────────

const engineCases = [];
const code = [
    'const value = 1;', 'let x = compute(a, b);', '\treturn value;', '    if (ready) {', '    }', '}', '',
    '// note: café 😀', 'import { a } from "./a";', 'export default value;', '\t\tindent\tinside', 'fn(x)\r',
    'function main() {', 'const b = 2;', 'const c = 3;', 'naïve ẞig', 'y'.repeat(40) + ' tail',
];
function source(lines) {
    const out = [];
    for (let i = 0; i < lines; i++) out.push(pick(code));
    return out.join('\n') + (rand() < 0.7 ? '\n' : '');
}
function edit(text, edits) {
    const lines = text.split('\n');
    for (let i = 0; i < edits; i++) {
        const at = Math.floor(rand() * (lines.length + 1));
        const op = rand();
        if (op < 0.3) lines.splice(at, 1);
        else if (op < 0.6) lines.splice(at, 0, pick(code));
        else if (op < 0.9 && lines[at] !== undefined) lines[at] = mutate(lines[at]);
        else lines.splice(at, 1, pick(code));
    }
    return lines.join('\n');
}
const documentJSON = (doc) => ({
    files: doc.files, additions: doc.additions, deletions: doc.deletions, ...(doc.error ? { error: doc.error } : {}),
});

const handPatches = [
    ['diff --git a/src/app.ts b/src/app.ts', 'index 1111111..2222222 100644', '--- a/src/app.ts', '+++ b/src/app.ts',
        '@@ -1,4 +1,4 @@ function main()', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'].join('\n'),
    ['diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,1 @@', '+hello'].join('\n'),
    ['diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye'].join('\n'),
    ['diff --git a/a.txt b/b.txt', 'similarity index 90%', 'rename from a.txt', 'rename to b.txt', '@@ -1 +1 @@', '-one', '+two'].join('\n'),
    ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' one', '', '-two', '\\ No newline at end of file', '+three'].join('\n'),
    ['--- "a/some dir/\\303\\251.ts"', '+++ "b/some dir/\\303\\251.ts"', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ['--- "a/quoted \\"name\\".ts"', '+++ "b/quoted \\"name\\".ts"', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ['--- a/x.txt\t2024-01-01 00:00:00', '+++ b/x.txt\t2024-01-02 00:00:00', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644', 'Binary files a/logo.png and b/logo.png differ'].join('\n'),
    ['diff --git a/one.ts b/one.ts', '--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '-a', '+b',
        'diff --git a/two.ts b/two.ts', '--- a/two.ts', '+++ b/two.ts', '@@ -1 +1 @@', '-c', '+d'].join('\n'),
    ['--- a/x.txt', '+++ b/x.txt', '@@ -10,2 +10,2 @@', '-a', '+b', '@@ -40,2 +40,2 @@ section here  ', '-c', '+d'].join('\n'),
    ['--- a/x.go', '+++ b/x.go', '@@ -1 +1 @@', '-\tfmt.Println("a")', '+\tfmt.Println("b")'].join('\n'),
    ['--- a/x.txt', '+++ b/x.txt', '@@@ -1198,2 +1198,2 @@@ triple', '-a', '+b'].join('\n'),
    ['--- a/x.txt\r', '+++ b/x.txt\r', '@@ -1 +1 @@\r', '-a\r', '+b\r'].join('\n'),
    ['--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@ ends\u2028here', '-a', '+b'].join('\n'),
    ['diff --git a/with space.txt b/with space.txt', '--- a/with space.txt', '+++ b/with space.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ['diff --git a/x b/y ', 'rename to z', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ['diff -u old new', '--- old', '+++ new', '@@ -1,2 +1,2 @@', '-x', '+y', ' z', 'junk line', '+after junk'].join('\n'),
    ['+++ b/only-new.txt', '@@ -0,0 +1 @@', '+a'].join('\n'),
    ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' keep', '--- not a header?', '+++ also odd', ' tail'].join('\n'),
    ['@@ malformed @@', '+x'].join('\n'),
    ['@@ -5 +5 @@', '-old', '+new'].join('\n'),
    'not a patch at all',
    '',
    '\n',
    ['--- a/e.ts', '+++ b/e.ts', '@@ -1,3 +1,3 @@', '-const naïve = "café";', '+const naïve = "cafés";', '-let 😀 = 1;', '+let 😀 = 2;'].join('\n'),
];
for (const patch of handPatches) {
    engineCases.push({ kind: 'parse', patch, expected: parsePatch(patch) });
    clearDiffCache();
    engineCases.push({ kind: 'patch', patch, options: {}, expected: documentJSON(buildDiffFromPatch(patch)) });
    engineCases.push({ kind: 'stats', patch, expected: countPatchStats(patch) });
}

for (let i = 0; i < 60; i++) {
    const oldText = source(Math.floor(rand() * 40));
    const newText = rand() < 0.1 ? source(Math.floor(rand() * 20)) : edit(oldText, 1 + Math.floor(rand() * 6));
    const name = pick(['src/app.ts', 'main.py', 'Dockerfile', 'README.md', 'data.unknownext', 'x.go']);
    const context = pick([0, 1, 3, 5]);
    const patch = (rand() < 0.5 ? `diff --git a/${name} b/${name}\n` : '')
        + createTwoFilesPatch(`a/${name}`, `b/${name}`, oldText, newText, '', '', { context });
    const options = pick([{}, { intraline: false }, { tabWidth: 2 }, { maxHighlightLines: 10 }]);
    clearDiffCache();
    engineCases.push({ kind: 'parse', patch, expected: parsePatch(patch) });
    engineCases.push({ kind: 'patch', patch, options, expected: documentJSON(buildDiffFromPatch(patch, options)) });
    engineCases.push({ kind: 'stats', patch, expected: countPatchStats(patch) });
}

for (let i = 0; i < 60; i++) {
    const oldText = rand() < 0.1 ? '' : source(Math.floor(rand() * 40));
    const newText = rand() < 0.1 ? '' : edit(oldText, Math.floor(rand() * 6));
    const options = pick([
        {}, { contextLines: 1 }, { contextLines: 0 }, { contextLines: 6 }, { ignoreWhitespace: true },
        { ignoreWhitespace: true, contextLines: 2 }, { diffBudget: { timeoutMs: 60000, maxEditLength: 2 } },
        { diffBudget: { timeoutMs: 60000, maxEditLength: 0 }, ignoreWhitespace: true }, { intraline: false },
    ]);
    const filePath = pick(['sample.txt', 'src/component.tsx', 'lib/x.rs']);
    clearDiffCache();
    engineCases.push({ kind: 'contents', path: filePath, oldText, newText, options, expected: documentJSON(buildDiffFromContents(filePath, oldText, newText, options)) });
    engineCases.push({ kind: 'contentStats', oldText, newText, expected: countContentStats(oldText, newText) });
}

// Lines past the word-diff limit, and a change block too big to pair.
const long = 'x'.repeat(1501);
for (const [oldText, newText] of [
    [`${long}\nkeep\n`, `${long}y\nkeep\n`],
    ['short a = 1;\n', `short a = 1; ${long}\n`],
    [Array.from({ length: 61 }, (_, i) => `const v${i} = ${i};`).join('\n'), Array.from({ length: 61 }, (_, i) => `const v${i} = ${i + 1};`).join('\n')],
]) {
    clearDiffCache();
    engineCases.push({ kind: 'contents', path: 'long.ts', oldText, newText, options: {}, expected: documentJSON(buildDiffFromContents('long.ts', oldText, newText)) });
}

write('diff-engine-vectors.json', `happy-app components/diff/engine with diff ${version}`, engineCases);
