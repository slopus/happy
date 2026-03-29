/**
 * Patches pglite-prisma-adapter to fix Bytes column handling.
 *
 * The adapter's parsePgBytes returns Uint8Array, which serializes as a JSON
 * object {"0":104,"1":101,...} across the JS-WASM boundary to the Prisma
 * query engine. The engine expects either a plain number[] or a base64 string.
 *
 * Fix: replace Uint8Array.from with Array.from so the result is a plain number[].
 *
 * Upstream issue: https://github.com/nicksrandall/pglite-prisma-adapter
 */
const fs = require('fs');
const path = require('path');

const files = [
    'node_modules/pglite-prisma-adapter/dist/index.mjs',
    'node_modules/pglite-prisma-adapter/dist/index.cjs',
];

let patched = 0;

for (const file of files) {
    const filePath = path.resolve(__dirname, '..', file);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;

    // Replace Uint8Array.from with Array.from in parsePgBytes and normalizeByteaArray
    content = content.replace(
        /Uint8Array\.from\(\s*\{\s*length:\s*hexString\.length\s*\/\s*2\s*\}/g,
        'Array.from({ length: hexString.length / 2 }'
    );

    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed pglite-prisma-adapter Bytes column handling (${patched} file(s))`);
}
