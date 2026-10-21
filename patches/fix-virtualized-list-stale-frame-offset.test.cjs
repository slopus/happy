const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replacements, patchSource, patchVirtualizedLists } = require('./fix-virtualized-list-stale-frame-offset.cjs');

const nodeModules = path.resolve(__dirname, '..', 'node_modules');
const aggregatorPath = fs.realpathSync(path.join(path.dirname(require.resolve('@react-native/virtualized-lists/package.json', {
    paths: [path.dirname(fs.realpathSync(path.join(nodeModules, 'react-native/package.json')))],
})), 'Lists/ListMetricsAggregator.js'));
const babel = require(require.resolve('@babel/core', { paths: [nodeModules] }));

// Rebuild the unpatched upstream source even after postinstall patched it.
function upstreamSource() {
    let source = fs.readFileSync(aggregatorPath, 'utf8');
    for (const [before, after] of replacements) source = source.replace(after, before);
    return source;
}

function loadAggregator(source) {
    const { code } = babel.transformSync(source, {
        babelrc: false,
        configFile: false,
        filename: 'ListMetricsAggregator.js',
        plugins: ['@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-modules-commonjs']
            .map(plugin => require.resolve(plugin, { paths: [nodeModules] })),
    });
    const module = { exports: {} };
    const requireStub = (id) => id === 'invariant'
        ? (condition, message) => { if (!condition) throw new Error(message); }
        : { keyExtractor: (item, index) => item.key ?? String(index) };
    new Function('require', 'module', 'exports', code)(requireStub, module, module.exports);
    return module.exports.default;
}

const Upstream = loadAggregator(upstreamSource());
const Patched = loadAggregator(patchSource(upstreamSource()));

// The home list shape from the Android trace: 88dp header and top padding
// before the first row, rows of mixed height, 114 rows, and a render window
// deep in the list while the initialNumToRender head (0-11) stays mounted.
const LEADING = 88;
const COUNT = 114;
const HEAD = 12;
const WINDOW = { first: 96, last: 110 };
const heights = new Map(Array.from({ length: COUNT + 1 }, (_, index) => [`row-${index}`, index % 3 === 0 ? 104 : 72]));

function realOffsets(keys) {
    const offsets = [];
    let offset = LEADING;
    for (const key of keys) {
        offsets.push(offset);
        offset += heights.get(key);
    }
    return offsets;
}

function layout(metrics, keys, indices) {
    const offsets = realOffsets(keys);
    for (const index of indices) {
        metrics.notifyCellLayout({
            cellIndex: index,
            cellKey: keys[index],
            orientation: { horizontal: false, rtl: false },
            layout: { x: 0, y: offsets[index], width: 411, height: heights.get(keys[index]) },
        });
    }
}

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
const initial = range(0, COUNT - 1).map(index => `row-${index}`);

// Every row was measured once (the user scrolled down), then the data changed
// while scrolled deep. Mounted cells (the head and the window) lay out again
// at their new indices; every other row keeps a frame from its old index.
function changedWhileScrolledDeep(Aggregator, keys) {
    const metrics = new Aggregator();
    layout(metrics, initial, range(0, COUNT - 1));
    layout(metrics, keys, [...range(0, HEAD - 1), ...range(WINDOW.first, Math.min(WINDOW.last, keys.length - 1))]);
    const props = {
        data: keys.map(key => ({ key })),
        getItem: (data, index) => data[index],
        getItemCount: data => data.length,
    };
    return { metrics, props, keys };
}

// VirtualizedList sizes the spacer between the mounted head and the render
// window from these two estimates; it is exact when it equals the real gap.
function spacerError({ metrics, props, keys }) {
    const first = metrics.getCellMetricsApprox(HEAD, props);
    const last = metrics.getCellMetricsApprox(WINDOW.first - 1, props);
    const offsets = realOffsets(keys);
    return (last.offset + last.length - first.offset) - (offsets[WINDOW.first] - offsets[HEAD]);
}

const scenarios = {
    // The original trigger: activity on an old session floats it to the top.
    'an old row moves to the top': [initial[80], ...initial.slice(0, 80), ...initial.slice(81)],
    'a new session is inserted at the top': ['row-114', ...initial],
    'a row above the window is deleted': [...initial.slice(0, 40), ...initial.slice(41)],
    'the last row moves to the top': [initial[COUNT - 1], ...initial.slice(0, COUNT - 1)],
};

for (const [name, keys] of Object.entries(scenarios)) {
    test(`${name}: upstream drops the leading padding, patched offsets and spacer are exact`, () => {
        // Upstream places stale rows as if the list had no header or
        // padding, so spacers bounded by them are off by about that much.
        const upstream = changedWhileScrolledDeep(Upstream, keys);
        const upstreamError = Math.max(...keys.map((_, index) => Math.abs(
            realOffsets(keys)[index] - upstream.metrics.getCellMetricsApprox(index, upstream.props).offset)));
        assert.ok(upstreamError >= LEADING - 16, `upstream error ${upstreamError}`);
        const list = changedWhileScrolledDeep(Patched, keys);
        assert.equal(spacerError(list), 0);
        const offsets = realOffsets(keys);
        let previous = -Infinity;
        for (let index = 0; index < keys.length; index++) {
            const { offset } = list.metrics.getCellMetricsApprox(index, list.props);
            assert.equal(offset, offsets[index], `row ${index}`);
            // Monotonic offsets keep the viewport binary search valid.
            assert.ok(offset > previous);
            previous = offset;
        }
    });
}

test('cached estimates follow rows that lay out again', t => {
    const keys = scenarios['an old row moves to the top'];
    const metrics = new Patched();
    layout(metrics, initial, range(0, COUNT - 1));
    const props = { data: keys.map(key => ({ key })), getItem: (data, index) => data[index], getItemCount: data => data.length };
    // Even before anything lays out again, chaining measured lengths already
    // gives the new layout.
    const before = metrics.getCellMetricsApprox(40, props).offset;
    assert.equal(before, realOffsets(keys)[40]);
    // A mounted head row then grows; the cached estimates must follow it.
    heights.set(keys[5], heights.get(keys[5]) + 30);
    t.after(() => heights.set(keys[5], heights.get(keys[5]) - 30));
    layout(metrics, keys, range(0, HEAD - 1));
    assert.equal(metrics.getCellMetricsApprox(40, props).offset, before + 30);
});

test('without any valid lower frame the estimate still starts after the leading padding', () => {
    const metrics = new Patched();
    layout(metrics, initial, range(0, 20));
    // Everything shifted by one and nothing has laid out again yet.
    const keys = ['row-114', ...initial];
    const props = { data: keys.map(key => ({ key })), getItem: (data, index) => data[index], getItemCount: data => data.length };
    assert.equal(metrics.getCellMetricsApprox(1, props).offset, LEADING + metrics.getAverageCellLength());
    assert.equal(metrics.getCellMetricsApprox(5, props).offset, LEADING + metrics.getAverageCellLength() + realOffsets(initial)[4] - LEADING);
});

test('a row laid out again in the same place is valid at its new index', () => {
    const metrics = new Patched();
    layout(metrics, ['a', 'b'].map(key => (heights.set(key, 72), key)), [0, 1]);
    const props = { data: [{ key: 'b' }, { key: 'a' }], getItem: (data, index) => data[index], getItemCount: data => data.length };
    metrics.notifyCellLayout({ cellIndex: 1, cellKey: 'a', orientation: { horizontal: false, rtl: false }, layout: { x: 0, y: LEADING + 72, width: 411, height: 72 } });
    metrics.notifyCellLayout({ cellIndex: 0, cellKey: 'b', orientation: { horizontal: false, rtl: false }, layout: { x: 0, y: LEADING, width: 411, height: 72 } });
    assert.equal(metrics.getCellMetrics(1, props)?.offset, LEADING + 72);
});

test('patched estimate matches upstream when nothing was reordered', () => {
    const props = { data: initial.map(key => ({ key })), getItem: (data, index) => data[index], getItemCount: data => data.length };
    for (const Aggregator of [Upstream, Patched]) {
        assert.deepEqual(new Aggregator().getCellMetricsApprox(5, props), { length: 0, offset: 0, index: 5, isMounted: false });
    }
    const upstream = new Upstream();
    const patched = new Patched();
    layout(upstream, initial, range(0, 30));
    layout(patched, initial, range(0, 30));
    for (const index of [0, 12, 30, 31, 80, COUNT - 1]) {
        assert.deepEqual(patched.getCellMetricsApprox(index, props), upstream.getCellMetricsApprox(index, props));
    }
});

function installation(t, layoutName) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'virtualized-lists-patch-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'node_modules');
    const reactNative = layoutName === 'isolated'
        ? path.join(root, '.pnpm/react-native@0.83.1/node_modules/react-native')
        : path.join(root, 'react-native');
    const packageRoot = layoutName === 'nested'
        ? path.join(reactNative, 'node_modules/@react-native/virtualized-lists')
        : layoutName === 'isolated'
            ? path.join(root, '.pnpm/@react-native+virtualized-lists@0.83.1/node_modules/@react-native/virtualized-lists')
            : path.join(root, '@react-native/virtualized-lists');
    fs.mkdirSync(reactNative, { recursive: true });
    fs.writeFileSync(path.join(reactNative, 'package.json'), '{"name":"react-native","version":"0.83.1"}');
    if (layoutName !== 'missing') {
        fs.mkdirSync(path.join(packageRoot, 'Lists'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@react-native/virtualized-lists","version":"0.83.1"}');
        fs.writeFileSync(path.join(packageRoot, 'Lists/ListMetricsAggregator.js'), upstreamSource());
    }
    if (layoutName === 'isolated') {
        fs.symlinkSync(reactNative, path.join(root, 'react-native'), 'dir');
        const dependencyLink = path.join(path.dirname(reactNative), '@react-native/virtualized-lists');
        fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
        fs.symlinkSync(packageRoot, dependencyLink, 'dir');
    }
    return { roots: [root], file: path.join(packageRoot, 'Lists/ListMetricsAggregator.js') };
}

test('patches the copy react-native loads once and fails on drifted or missing source', t => {
    for (const layoutName of ['hoisted', 'nested', 'isolated']) {
        const { roots, file } = installation(t, layoutName);
        assert.deepEqual(patchVirtualizedLists(roots), { installed: 1, changed: 1 });
        assert.equal(fs.readFileSync(file, 'utf8'), patchSource(upstreamSource()));
        assert.deepEqual(patchVirtualizedLists(roots), { installed: 1, changed: 0 });
        fs.writeFileSync(file, 'drifted');
        assert.throws(() => patchVirtualizedLists(roots), /Unexpected VirtualizedList/);
    }
    assert.throws(() => patchVirtualizedLists(installation(t, 'missing').roots), /without @react-native\/virtualized-lists/);
    assert.throws(() => patchSource(upstreamSource().replace(replacements[2][0], '')), /Unexpected VirtualizedList/);
});
