const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { patchSource, patchFlashListWeb } = require('./fix-flash-list-web-inversion.cjs');

const sourcePath = 'src/recyclerview/utils/measureLayout.web.ts';
const distPath = 'dist/recyclerview/utils/measureLayout.web.js';
const fixture = `export function measureFirstChildLayout(childContainerView, parentView) {
  const childRect = childContainerView.getBoundingClientRect();
  const parentRect = parentView.getBoundingClientRect();
  const scrollOffsets = getScrollOffsets(childContainerView, parentView);
  return {
    x: childRect.left - parentRect.left + scrollOffsets.scrollX,
    y: childRect.top - parentRect.top + scrollOffsets.scrollY,
  };
}`;

function installation(t, roots = ['node_modules']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-list-web-patch-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const root of roots) {
        const pkg = path.join(directory, root, '@shopify/flash-list');
        for (const [file, text] of [
            [sourcePath, fixture], [distPath, fixture.replace(/^  /gm, '    ')],
            ['package.json', '{"name":"@shopify/flash-list","version":"2.3.1"}'],
            ['src/recyclerview/utils/measureLayout.ts', 'native source unchanged'],
            ['dist/recyclerview/utils/measureLayout.js', 'native bundle unchanged'],
        ]) {
            fs.mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true });
            fs.writeFileSync(path.join(pkg, file), text);
        }
    }
    return roots.map(root => path.join(directory, root));
}

test('patches both web entrypoints, leaves native/version bytes intact, and is idempotent', t => {
    const roots = installation(t, ['node_modules', 'packages/happy-app/node_modules']);
    assert.equal(patchFlashListWeb(roots), 4);
    assert.equal(patchFlashListWeb(roots), 0);
    for (const root of roots) {
        const pkg = path.join(root, '@shopify/flash-list');
        assert.match(fs.readFileSync(path.join(pkg, sourcePath), 'utf8'), /matrix.m22 < 0/);
        assert.match(fs.readFileSync(path.join(pkg, distPath), 'utf8'), /matrix.m11 < 0/);
        assert.equal(fs.readFileSync(path.join(pkg, 'src/recyclerview/utils/measureLayout.ts'), 'utf8'), 'native source unchanged');
        assert.equal(fs.readFileSync(path.join(pkg, 'dist/recyclerview/utils/measureLayout.js'), 'utf8'), 'native bundle unchanged');
        assert.equal(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'), '{"name":"@shopify/flash-list","version":"2.3.1"}');
    }
});

test('fails on changed, duplicate, or partial upstream code before writing any file', t => {
    for (const source of [
        fixture.replace('childRect.top', 'childRect.bottom'),
        fixture + fixture,
        patchSource(fixture).replace('matrix.m22 < 0', 'matrix.m22 > 0'),
    ]) assert.throws(() => patchSource(source), /Unexpected FlashList/);
    const roots = installation(t);
    const pkg = path.join(roots[0], '@shopify/flash-list');
    fs.writeFileSync(path.join(pkg, distPath), 'upstream changed');
    assert.throws(() => patchFlashListWeb(roots), /Unexpected FlashList/);
    assert.equal(fs.readFileSync(path.join(pkg, sourcePath), 'utf8'), fixture);
});

test('does nothing when FlashList is not installed', t => {
    const roots = installation(t);
    assert.equal(patchFlashListWeb([path.join(roots[0], 'missing')]), 0);
});

for (const file of [sourcePath, distPath]) {
    test(`${file}: inverted offsets remain constant while scrolling; ordinary axes are unchanged`, () => {
        // Exercise the actual installed implementation, not a reimplementation
        // of its scroll-offset traversal. patchSource also accepts patched input.
        const source = fs.readFileSync(path.join(__dirname, '../node_modules/@shopify/flash-list', file), 'utf8');
        const compiled = ts.transpileModule(patchSource(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
        const context = { exports: {}, getComputedStyle: element => ({ transform: element.transform }), DOMMatrixReadOnly: class {
            constructor(transform) {
                const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
                this.m11 = values[0];
                this.m22 = values[transform.startsWith('matrix3d') ? 5 : 3];
            }
        } };
        vm.runInNewContext(compiled, context);
        const measure = context.exports.measureFirstChildLayout;
        for (const [transform, flipX, flipY] of [
            ['none', false, false],
            ['matrix(1,0,0,1,20,30)', false, false],
            ['matrix(1,0,0,-1,0,0)', false, true],
            ['matrix(-1,0,0,1,0,0)', true, false],
            ['matrix3d(-1,0,0,0,0,-1,0,0,0,0,1,0,0,0,0,1)', true, true],
        ]) {
            for (const scroll of [0, 400, 1600, 8000]) {
                const parentRect = { left: 100, right: 490, top: 200, bottom: 800 };
                const parent = { transform, getBoundingClientRect: () => parentRect };
                const scroller = { parentElement: parent, scrollTop: scroll, scrollLeft: scroll };
                const width = 12000, height = 30000, x = 11, y = 8;
                const left = flipX ? parentRect.right - (x - scroll) - width : parentRect.left + x - scroll;
                const top = flipY ? parentRect.bottom - (y - scroll) - height : parentRect.top + y - scroll;
                const child = { parentElement: scroller, getBoundingClientRect: () => ({ left, right: left + width, top, bottom: top + height, width, height }) };
                const result = measure(child, parent);
                assert.deepEqual({ x: result.x, y: result.y, width: result.width, height: result.height }, { x, y, width, height }, `${transform}, scroll=${scroll}`);
            }
        }
    });
}