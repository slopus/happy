import * as React from 'react';
import { act } from 'react';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
// @ts-expect-error no local renderer declarations
import TestRenderer from 'react-test-renderer';
import { createAnchoredWebVirtualizedList } from './anchoredWebVirtualizedList';
import { WebTranscriptScrollCoordinator } from './webTranscriptScrollCoordinator';

const require = createRequire(import.meta.url);
// Same explicit Web export as production (bypasses Unistyles' RN wrapper).
const VendorList = require('react-native-web/dist/cjs/exports/VirtualizedList');
const List = createAnchoredWebVirtualizedList(VendorList);
let transformedEntry: string;
// Babel/plugin cold loading is suite setup, not part of a 5s behavior test.
beforeAll(() => {
    const babel = require('@babel/core');
    const filename = fileURLToPath(new URL('./TranscriptList.web.tsx', import.meta.url));
    transformedEntry = babel.transformFileSync(filename, { cwd: process.cwd(),
        caller: { name: 'metro', platform: 'web', supportsStaticESM: false } }).code;
}, 30000);
const props = (data: number[]) => ({ data, getItem: (rows: number[], index: number) => rows[index],
    getItemCount: (rows: number[]) => rows.length, keyExtractor: (row: number) => `wire-${row}`,
    getItemLayout: (_: unknown, index: number) => ({ index, offset: index * 100, length: 100 }),
    initialNumToRender: 10, windowSize: 5, maxToRenderPerBatch: 10,
});
afterEach(() => { vi.restoreAllMocks(); });

it('coordinated commits measure only a history transaction and never apply an estimated fallback', async () => {
    let list: any; let renderer: any; let rowTop = 100;
    const measure = vi.fn(() => ({ top: rowTop, bottom: rowTop + 100 }));
    const anchor = { isConnected: true, getAttribute: () => 'wire-1', getBoundingClientRect: measure };
    const node = { scrollTop: 100, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
        querySelectorAll: () => [anchor], addEventListener() {}, removeEventListener() {} };
    const write = vi.fn(({ offset }: { offset: number }) => { rowTop -= offset - node.scrollTop; node.scrollTop = offset; });
    const coordinator = new WebTranscriptScrollCoordinator(() => ({ scrollToOffset: write, scrollToIndex() {}, scrollToEnd() {} }));
    const Row = ({ phase }: { phase: number }) => {
        React.useLayoutEffect(() => { if (phase === 1) rowTop += 40; }, [phase]);
        return <img />;
    };
    const render = (phase: number) => <List {...props(phase ? [0, 1] : [1])}
        ref={(value: any) => { list = value; }} scrollCoordinator={coordinator}
        renderItem={({ item }: { item: number }) => item === 1 ? <Row phase={phase} /> : <span />} />;
    await act(async () => { renderer = TestRenderer.create(render(0)); });
    list._scrollRef = { getScrollableNode: () => node, scrollTo: vi.fn() };
    try {
        await act(async () => renderer.update(render(0)));
        expect(measure).not.toHaveBeenCalled();
        coordinator.userIntent('older');
        const id = coordinator.beginHistory('page', 'older')!;
        await act(async () => renderer.update(render(1)));
        expect(write).toHaveBeenCalledExactlyOnceWith({ offset: 140, animated: false });
        expect(rowTop).toBe(100);
        measure.mockClear();
        await act(async () => renderer.update(render(2)));
        expect(measure).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledTimes(1);
        coordinator.finishHistory(id);
        coordinator.userIntent('older'); coordinator.beginHistory('page-2', 'older');
        anchor.isConnected = false;
        await act(async () => renderer.update(render(3)));
        expect(write).toHaveBeenCalledTimes(1);
    } finally { act(() => renderer.unmount()); coordinator.dispose(); }
});

it('keeps a visible loaded image mounted through prepend and corrects offset before paint with bounded cells', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const unmount = vi.fn();
    const Row = ({ id }: { id: number }) => {
        React.useEffect(() => () => { unmount(id); }, [id]);
        return <img data-row={id} src={`image-${id}`} />;
    };
    let list: any; let renderer: any;
    const offsetChanged = vi.fn();
    const render = (data: number[], growth = 0) => <List {...props(data)} ref={(value: any) => { list = value; }}
        onAnchorOffsetChange={offsetChanged}
        getItemLayout={(_: unknown, index: number) => ({ index, offset: index * 100 + (data[index] >= 544 ? growth : 0),
            length: 100 + (data[index] === 543 ? growth : 0) })}
        renderItem={({ item }: { item: number }) => <Row id={item} />} />;
    await act(async () => { renderer = TestRenderer.create(render(Array.from({ length: 67 }, (_, i) => 534 + i))); });
    const node = { scrollTop: 1000, addEventListener() {}, removeEventListener() {} };
    const scrollTo = vi.fn(({ y }: { y: number }) => { node.scrollTop = y; });
    list._scrollRef = { scrollTo, getScrollableNode: () => node };
    list._scrollMetrics = { ...list._scrollMetrics, offset: 1000, visibleLength: 600, contentLength: 6700 };
    // Use the real vendor mask/state and render cells, not a mocked FlatList.
    await act(async () => { list.setState({ cellsAroundViewport: { first: 8, last: 18 },
        renderMask: VendorList._createRenderMask(list.props, { first: 8, last: 18 }) }); });
    const image = renderer.root.findByProps({ 'data-row': 544 });
    unmount.mockClear(); scrollTo.mockClear();
    await act(async () => { renderer.update(render(Array.from({ length: 366 }, (_, i) => 235 + i))); });
    try {
        expect(unmount.mock.calls.flat()).not.toContain(544);
        expect(renderer.root.findByProps({ 'data-row': 544 })).toBe(image);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 30900, animated: false }));
        expect(offsetChanged).toHaveBeenLastCalledWith(30900);
        // A late image/layout measurement above the visible anchor must not
        // wait for asynchronous reading-marker correction to converge.
        scrollTo.mockClear();
        await act(async () => { renderer.update(render(Array.from({ length: 366 }, (_, i) => 235 + i), 147)); });
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 31047, animated: false }));
        expect(unmount.mock.calls.flat()).not.toContain(544);
        expect(renderer.root.findByProps({ 'data-row': 544 })).toBe(image);
        expect(renderer.root.findAllByType('img').length).toBeLessThan(80);
    } finally { act(() => renderer.unmount()); }
});

it('rejects unsupported virtualizer internals instead of rendering the entire history', () => {
    expect(() => createAnchoredWebVirtualizedList(class {})).toThrow('Unsupported Web transcript virtualizer');
});

it.each([false, true])('uses committed DOM displacement instead of estimated prefix or duplicate browser anchoring (browser: %s)', async browserAnchored => {
    let list: any; let renderer: any; let rowTop = 100;
    const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 100 }) };
    const node = { scrollTop: 100, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
        querySelectorAll: () => [anchor], addEventListener() {}, removeEventListener() {} };
    const Row = ({ phase }: { phase: number }) => {
        React.useLayoutEffect(() => {
            if (phase === 1) { rowTop = browserAnchored ? 100 : 140; if (browserAnchored) node.scrollTop = 140; }
        }, [phase]);
        return <img data-transcript-key="anchor" />;
    };
    const render = (phase: number) => <List {...props(phase ? [0, 1] : [1])} ref={(value: any) => { list = value; }}
        getItemLayout={(_: unknown, index: number) => ({ index, offset: index * (phase === 2 ? 190 : 200), length: 200 })}
        renderItem={({ item }: { item: number }) => item === 1 ? <Row phase={phase} /> : <span />} />;
    await act(async () => { renderer = TestRenderer.create(render(0)); });
    list._scrollMetrics = { ...list._scrollMetrics, offset: 100, visibleLength: 600, contentLength: 1000 };
    list._scrollRef = { getScrollableNode: () => node, scrollTo: ({ y }: { y: number }) => {
        rowTop -= y - node.scrollTop; node.scrollTop = y;
    } };
    try {
        await act(async () => { renderer.update(render(1)); });
        expect(node.scrollTop).toBe(140);
        expect(rowTop).toBe(100);
        // Measured prefix estimates change while actual DOM stays unchanged.
        await act(async () => { renderer.update(render(2)); });
        expect(node.scrollTop).toBe(140);
        expect(rowTop).toBe(100);
    } finally { act(() => renderer.unmount()); }
});

it.each([[196, true, false], [891, true, false], [196, false, false], [36, true, true]] as const)('anchors visible media or falls back to a group (%spx, media visible: %s)', async (growth, mediaVisible, sliver) => {
    let list: any; let renderer: any; const initialMediaTop = sliver ? 2 : mediaVisible ? 60 : 700; let mediaTop = initialMediaTop; let summaryTop = sliver ? -148 : 0;
    const summary = { isConnected: true, getAttribute: () => 'summary',
        getBoundingClientRect: () => ({ top: summaryTop, bottom: summaryTop + (sliver ? 150 : 36) }) };
    const media = { isConnected: true, getAttribute: () => 'video',
        getBoundingClientRect: () => ({ top: mediaTop, bottom: mediaTop + 441 }) };
    const node = { scrollTop: 100, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
        querySelectorAll: () => [summary, media], addEventListener() {}, removeEventListener() {} };
    const Row = ({ phase }: { phase: number }) => {
        React.useLayoutEffect(() => { if (phase === 1) mediaTop += growth; }, [phase]);
        return <video />;
    };
    const data = (phase: number) => [
        { id: 'summary', type: sliver ? 'image-group' : 'agent-work-group' },
        ...(phase ? [{ id: 'older', type: 'message' }] : []),
        { id: 'video', type: 'message' },
    ];
    const render = (phase: number) => <List {...props([])} data={data(phase)}
        keyExtractor={(row: any) => row.id} ref={(value: any) => { list = value; }}
        renderItem={({ item }: any) => item.id === 'video' ? <Row phase={phase} /> : <span />} />;
    await act(async () => { renderer = TestRenderer.create(render(0)); });
    list._scrollMetrics = { ...list._scrollMetrics, offset: 100, visibleLength: 600, contentLength: 1000 };
    list._scrollRef = { getScrollableNode: () => node, scrollTo: ({ y }: { y: number }) => {
        const delta = y - node.scrollTop; mediaTop -= delta; summaryTop -= delta; node.scrollTop = y;
    } };
    try {
        await act(async () => renderer.update(render(1)));
        expect(mediaTop).toBe(mediaVisible ? initialMediaTop : initialMediaTop + growth);
        expect(node.scrollTop).toBe(mediaVisible ? 100 + growth : 100);
    } finally { act(() => renderer.unmount()); }
});

it('initializes the actual Web entry after the app Babel/Unistyles transform', () => {
    const module = { exports: {} as any };
    const runtimeRequire = (id: string) => {
        if (id === './anchoredWebVirtualizedList') return { createAnchoredWebVirtualizedList };
        if (id === 'react-native-web/dist/exports/VirtualizedList') return VendorList;
        // Model the exact boundary that failed in Metro: Unistyles emits a
        // functional wrapper, not the class whose private statics are required.
        if (id.includes('unistyles') && id.includes('VirtualizedList')) return { VirtualizedList: () => null };
        return require(id);
    };
    new Function('require', 'module', 'exports', transformedEntry)(runtimeRequire, module, module.exports);
    expect(module.exports.TranscriptList.render({ data: [], getItemLayout: () => ({ index: 0, offset: 0, length: 100 }) }, null).type.name)
        .toBe('AnchoredWebVirtualizedList');
});
