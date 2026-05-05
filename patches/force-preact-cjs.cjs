/**
 * Force every preact subpath export to resolve to the CJS bundle.
 * The default exports map sends ESM importers to .mjs and CJS importers to
 * .js, which Metro registers as two separate module instances when both
 * conventions exist in the bundle (we have ESM @pierre/trees and CJS
 * babel-transformed app code). Two instances == two `options` objects ==
 * preact/hooks patches one and the renderer uses the other == `__H` crash.
 *
 * Usage: `node patches/force-preact-cjs.cjs`
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'node_modules', 'preact', 'package.json');
if (!fs.existsSync(pkgPath)) {
    console.error('[force-preact-cjs] preact package.json not found at', pkgPath);
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function rewriteExports(exportsObj) {
    for (const key of Object.keys(exportsObj)) {
        const entry = exportsObj[key];
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const cjs = entry.require || entry.default;
        if (typeof cjs !== 'string') continue;
        const next = { import: cjs, require: cjs, default: cjs };
        if (entry.types) next.types = entry.types;
        exportsObj[key] = next;
    }
}

if (pkg.exports) rewriteExports(pkg.exports);

// Drop the top-level "module" field too — Metro sometimes prefers it over
// "main"/"require" condition, leading back to the ESM bundle.
if (pkg.module) delete pkg.module;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('[force-preact-cjs] patched preact package.json — all subpaths point to CJS');
