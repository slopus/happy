/**
 * Patch @pierre/trees to eagerly load preact/hooks before its renderer runs.
 *
 * Background:
 *   @pierre/trees ships an internal Preact 11 renderer for the file-tree
 *   web component. preact/hooks installs its currentComponent tracking by
 *   patching `options.__r` / `options.__b` / `options.diffed` at module
 *   load time. Without those patches, Preact starts a render, hits a hook,
 *   and crashes with `Cannot read properties of undefined (reading "__H")`.
 *
 *   With Metro's `inlineRequires` enabled (required for @shopify/react-
 *   native-skia on web), preact/hooks isn't loaded until its first export
 *   is *used* — which happens inside the very first Preact render, far too
 *   late for the options patch to take effect.
 *
 *   Adding `import "preact/hooks";` to dist/render/runtime.js (the file
 *   that calls `render()`) primes the module load before any preact render
 *   can run, eliminating the race.
 *
 * Idempotent — safe to run after every install.
 */
const fs = require('fs');
const path = require('path');

const targets = [
    path.resolve(__dirname, '..', 'node_modules', '@pierre', 'trees', 'dist', 'render', 'runtime.js'),
    path.resolve(__dirname, '..', 'packages', 'happy-app', 'node_modules', '@pierre', 'trees', 'dist', 'render', 'runtime.js'),
];

const MARKER = 'preact/hooks';
const HOOKS_IMPORT = 'import "preact/hooks";\n';

let patched = 0;
for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(MARKER)) continue;

    const insertAfter = 'import { h, hydrate, render } from "preact";';
    const idx = src.indexOf(insertAfter);
    if (idx === -1) {
        console.warn(`[fix-pierre-trees-preact-hooks] could not find anchor in ${file}, skipping`);
        continue;
    }
    const insertAt = idx + insertAfter.length;
    const next =
        src.slice(0, insertAt) +
        '\n' +
        HOOKS_IMPORT +
        src.slice(insertAt);
    fs.writeFileSync(file, next, 'utf8');
    patched++;
}

if (patched > 0) {
    console.log(`[fix-pierre-trees-preact-hooks] patched ${patched} file(s)`);
}
