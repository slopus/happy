/**
 * Adds `./style.js` to the `exports` map of @pierre/diffs so consumers can
 * import the raw CSS string directly. Also writes a minimal style.d.ts next
 * to dist/style.js so TypeScript resolves the import.
 *
 * We need the CSS string at runtime on native (WebView) to inject into the
 * document head — the web build normally pulls it in via the custom element's
 * shadow root, but on native we render SSR HTML in a plain WebView.
 */
const fs = require('fs');
const path = require('path');

const pkgDirs = [
    path.resolve(__dirname, '..', 'node_modules/@pierre/diffs'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules/@pierre/diffs'),
];

let patched = 0;

for (const pkgDir of pkgDirs) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    const styleDtsPath = path.join(pkgDir, 'dist/style.d.ts');

    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (pkg.exports && !pkg.exports['./style.js']) {
        pkg.exports['./style.js'] = {
            types: './dist/style.d.ts',
            import: './dist/style.js',
        };
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        patched++;
    }

    if (fs.existsSync(path.dirname(styleDtsPath)) && !fs.existsSync(styleDtsPath)) {
        fs.writeFileSync(
            styleDtsPath,
            'declare const style_default: string;\nexport default style_default;\n',
            'utf8'
        );
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Exposed @pierre/diffs/style.js (${patched} file(s))`);
}
