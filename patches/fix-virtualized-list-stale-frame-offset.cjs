/**
 * React Native 0.83 VirtualizedList caches cell frames by key. When rows are
 * reordered or inserted, unmounted cells keep a frame for their old index, so
 * ListMetricsAggregator.getCellMetricsApprox falls back to
 * `averageCellLength * index`. That estimate drops everything ahead of the
 * first cell (ListHeaderComponent, contentContainerStyle paddingTop), so a
 * spacer bounded by a stale row is that much off while one bounded by a
 * measured row is not. Mounting or unmounting the boundary row then changes
 * the content height, which moves the window boundary again: deep in the home
 * session list on Android the content height flipped by ~90dp every ~80ms.
 *
 * Estimate a stale row by chaining from where the first cell starts: frames
 * still valid at their index are exact, other rows add their last measured
 * length. A reorder does not change row heights, so the estimate matches the
 * real layout and the boundary stops moving. A frame laid out again in the
 * same place is also re-indexed. Pure JS: applies to iOS and Android alike.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const replacements = [
    [`  _highestMeasuredCellIndex = 0;
  _measuredCellsLength = 0;`,
    `  _highestMeasuredCellIndex = 0;
  // [happy] Where the first cell starts (header, leading padding), and the
  // estimated end of each row for the current data, filled in lazily and
  // dropped whenever a frame changes.
  _leadingOffset = 0;
  _layoutVersion = 0;
  _estimatedEnds: ?{data: mixed, version: number, ends: Array<number>} = null;
  _measuredCellsLength = 0;`],
    [`    const curr = this._cellMetrics.get(cellKey);

    if (!curr || next.offset !== curr.offset || next.length !== curr.length) {`,
    `    const curr = this._cellMetrics.get(cellKey);
    if (cellIndex === 0 && next.offset !== this._leadingOffset) {
      this._leadingOffset = next.offset;
      this._layoutVersion++;
    }

    if (!curr || next.offset !== curr.offset || next.length !== curr.length) {
      this._layoutVersion++;`],
    [`    } else {
      curr.isMounted = true;
      return false;`,
    `    } else {
      // [happy] Same place, new index: the frame is valid at its new index.
      if (curr.index !== cellIndex) {
        curr.index = cellIndex;
        this._layoutVersion++;
      }
      curr.isMounted = true;
      return false;`],
    [`      if (offset == null) {
        offset = this._averageCellLength * index;
      }

      const {data, getItemCount} = props;
      invariant(
        index >= 0 && index < getItemCount(data),
        'Tried to get frame for out of range index ' + index,
      );
      return {
        length: this._averageCellLength,`,
    `      const {data, getItem, getItemCount} = props;
      invariant(
        index >= 0 && index < getItemCount(data),
        'Tried to get frame for out of range index ' + index,
      );
      // [happy] Reordered rows keep frames recorded at their old index, so
      // \`averageCellLength * index\` would drop the header and padding. Chain
      // from the first cell's start instead: a frame still valid at its index
      // is exact, any other row adds its last measured length (a reorder
      // keeps heights) or the average. Amortized O(1) per estimate.
      const keyExtractor = props.keyExtractor ?? defaultKeyExtractor;
      const knownLength = (cellIndex: number): ?number =>
        this._cellMetrics.get(keyExtractor(getItem(data, cellIndex), cellIndex))
          ?.length;
      if (offset == null) {
        let cache = this._estimatedEnds;
        if (
          cache == null ||
          cache.data !== data ||
          cache.version !== this._layoutVersion
        ) {
          cache = {data, version: this._layoutVersion, ends: []};
          this._estimatedEnds = cache;
        }
        const ends = cache.ends;
        for (let i = ends.length; i < index; i++) {
          const frame = this.getCellMetrics(i, props);
          ends.push(
            frame
              ? frame.offset + frame.length
              : (i === 0 ? this._leadingOffset : ends[i - 1]) +
                  (knownLength(i) ?? this._averageCellLength),
          );
        }
        offset = index === 0 ? this._leadingOffset : ends[index - 1];
      }
      return {
        length: knownLength(index) ?? this._averageCellLength,`],
    [`      this._cellMetrics.clear();
    }`,
    `      this._cellMetrics.clear();
      this._layoutVersion++;
    }`],
];

function patchSource(source) {
    if (replacements.every(([, after]) => source.split(after).length === 2)) return source;
    for (const [before, after] of replacements) {
        if (source.split(before).length !== 2 || source.includes(after)) {
            throw new Error('[patch] Unexpected VirtualizedList ListMetricsAggregator source; review fix-virtualized-list-stale-frame-offset.cjs');
        }
    }
    for (const [before, after] of replacements) source = source.replace(before, after);
    return source;
}

function patchVirtualizedLists(nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
]) {
    const files = new Set();
    for (const root of nodeModulesRoots) {
        const reactNative = path.join(root, 'react-native');
        if (!fs.existsSync(path.join(reactNative, 'package.json'))) continue;
        // Resolve from react-native's real location so Node finds the copy it
        // loads in nested, hoisted, and pnpm isolated dependency layouts.
        const requireFromReactNative = createRequire(fs.realpathSync(path.join(reactNative, 'package.json')));
        let packageRoot;
        try {
            packageRoot = path.dirname(requireFromReactNative.resolve('@react-native/virtualized-lists/package.json'));
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Error('[patch] react-native is installed without @react-native/virtualized-lists; review fix-virtualized-list-stale-frame-offset.cjs');
        }
        files.add(fs.realpathSync(path.join(packageRoot, 'Lists/ListMetricsAggregator.js')));
    }
    const changes = new Map();
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        const patched = patchSource(source);
        if (patched !== source) changes.set(file, patched);
    }
    // Validate every installed copy before changing any of them.
    for (const [file, source] of changes) fs.writeFileSync(file, source);
    if (changes.size) console.log(`[patch] Fixed VirtualizedList stale frame offsets (${changes.size} file(s))`);
    return { installed: files.size, changed: changes.size };
}

module.exports = { replacements, patchSource, patchVirtualizedLists };
if (require.main === module) patchVirtualizedLists();
