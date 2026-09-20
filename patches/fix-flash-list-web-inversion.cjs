/**
 * FlashList 2.3.1 (also 2.3.2) measures a flipped DOM container in visual
 * coordinates, then treats the result as a layout offset. As the user scrolls,
 * that offset drifts and the recycler stops mounting the visible rows.
 * Measure from the opposite edge on flipped axes. Only .web files are patched;
 * native measurement, package versions, and native dependencies stay untouched.
 */
const fs = require('node:fs');
const path = require('node:path');

const replacements = [
    ['const scrollOffsets = getScrollOffsets(childContainerView, parentView);',
        'const scrollOffsets = getScrollOffsets(childContainerView, parentView);\n'
        + 'const transform = getComputedStyle(parentView).transform;\n'
        + 'const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);'],
    ['x: childRect.left - parentRect.left + scrollOffsets.scrollX,',
        'x: (matrix && matrix.m11 < 0 ? parentRect.right - childRect.right : childRect.left - parentRect.left) + scrollOffsets.scrollX,'],
    ['y: childRect.top - parentRect.top + scrollOffsets.scrollY,',
        'y: (matrix && matrix.m22 < 0 ? parentRect.bottom - childRect.bottom : childRect.top - parentRect.top) + scrollOffsets.scrollY,'],
];

function patchSource(source) {
    // Compare without indentation so both the TypeScript source and emitted JS
    // use the same checked replacement. Partial/drifted patches fail, not skip.
    const normalized = source.replace(/^[ \t]+/gm, '');
    if (replacements.every(([, after]) => normalized.split(after).length === 2)) return source;
    for (const [before, after] of replacements) {
        if (normalized.split(before).length !== 2 || normalized.includes(after)) {
            throw new Error('[patch] Unexpected FlashList web measurement source; review fix-flash-list-web-inversion.cjs');
        }
    }
    for (const [before, after] of replacements) {
        const indent = source.slice(0, source.indexOf(before)).split('\n').pop();
        source = source.replace(before, after.replace(/\n/g, `\n${indent}`));
    }
    return source;
}

function patchFlashListWeb(nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
]) {
    const changes = new Map();
    for (const root of nodeModulesRoots) {
        const packageRoot = path.join(root, '@shopify/flash-list');
        if (!fs.existsSync(path.join(packageRoot, 'package.json'))) continue;
        for (const relative of ['src/recyclerview/utils/measureLayout.web.ts', 'dist/recyclerview/utils/measureLayout.web.js']) {
            const file = fs.realpathSync(path.join(packageRoot, relative));
            const source = fs.readFileSync(file, 'utf8');
            const patched = patchSource(source);
            if (patched !== source) changes.set(file, patched);
        }
    }
    // Validate every installed copy before changing any of them.
    for (const [file, source] of changes) fs.writeFileSync(file, source);
    if (changes.size) console.log(`[patch] Fixed FlashList inverted web measurement (${changes.size} file(s))`);
    return changes.size;
}

module.exports = { patchSource, patchFlashListWeb };
if (require.main === module) patchFlashListWeb();