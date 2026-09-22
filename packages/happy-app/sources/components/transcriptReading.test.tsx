import * as React from 'react';
import { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error no local declarations
import TestRenderer from 'react-test-renderer';
import { expandedGroupKeys, groupIsExpanded, findAnchorIndex, handleTranscriptWebWheel, useTranscriptReading, TranscriptReadingMarker, TranscriptReadingContext, setGroupExpansion } from './transcriptReading';
import type { ReadingState } from '@/sync/localHistoryStore';
vi.mock('react-native', () => ({ View: 'View' }));
const msg = (id: string) => ({ id, kind: 'agent-text', text: id, createdAt: 1, localId: null }) as any;
const group = (id: string, ids: string[]) => ({ type: 'tool-group', id, messages: ids.map(msg), hasRunning: false, hasPendingPermission: false }) as any;
const wire = (id: string) => id.replace(/-replayed$/, '');

describe('durable transcript reading anchors', () => {
    it('does not measure or persist on coordinated Web scroll events', async () => {
        const measure = vi.fn(() => ({ top: 0, height: 600 }));
        const save = vi.fn();
        const adapter = { key: 'web-idle', read: async () => null, save, wireId: wire, wireSeq: () => 1 };
        let reading: ReturnType<typeof useTranscriptReading>;
        let settled = false;
        function Probe() {
            reading = useTranscriptReading({ adapter, items: [], inverted: false, isAtLatest: false,
                externallyScheduled: true, canCapture: () => settled,
                listRef: { current: null }, viewportRef: { current: { getBoundingClientRect: measure } },
                expanded: [], restoreExpanded: () => {} });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe />); });
        const row = { isConnected: true, getBoundingClientRect: vi.fn(() => ({ top: -20, height: 200 })) };
        reading!.markers!.register('message', row as any, 0);
        reading!.cancelRestore('older');
        for (let i = 0; i < 50; i++) reading!.scroll(i, 500);
        await reading!.capture();
        expect(measure).not.toHaveBeenCalled();
        expect(row.getBoundingClientRect).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        settled = true;
        await reading!.capture();
        expect(measure).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ anchorId: 'message', offset: -20 }));
        act(() => renderer.unmount());
    });
    it('keeps public normal transcripts at the top when automatic latest layout is disabled', async () => {
        const scrollToEnd = vi.fn();
        let reading: ReturnType<typeof useTranscriptReading>;
        function Probe() {
            reading = useTranscriptReading({ items: [], inverted: false, isAtLatest: true, followLatestOnLayout: false,
                listRef: { current: { scrollToEnd } }, viewportRef: { current: null }, expanded: [], restoreExpanded: () => {} });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe />); });
        await reading!.layout();
        expect(scrollToEnd).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
    it('follows the latest normal-orientation content until the reader claims scrolling', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const scrollToEnd = vi.fn();
        let reading: ReturnType<typeof useTranscriptReading>;
        function Probe() {
            reading = useTranscriptReading({ items: [], inverted: false, isAtLatest: true,
                listRef: { current: { scrollToEnd } }, viewportRef: { current: null }, expanded: [], restoreExpanded: () => {} });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe />); });
        reading!.scroll(0, 1000); // Initial virtualized layout is not user intent.
        scrollToEnd.mockClear();
        await reading!.layout();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
        scrollToEnd.mockClear();
        reading!.cancelRestore('older');
        reading!.scroll(0, 0); // A measurement event at the tail is not downward intent.
        await reading!.layout();
        expect(scrollToEnd).not.toHaveBeenCalled();
        reading!.jumpLatest();
        await reading!.layout();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
        act(() => renderer.unmount());
    });

    it('keeps a latest jump from being overwritten by a delayed persisted reading state', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const saved: ReadingState = { version: 1, anchorId: 'old', anchorSeq: 1, offset: -30, expandedGroupIds: [], followLatest: false };
        let resolveRead!: (state: ReadingState) => void;
        const read = new Promise<ReadingState>(resolve => { resolveRead = resolve; });
        const scrollToEnd = vi.fn();
        const scrollToOffset = vi.fn();
        let reading: ReturnType<typeof useTranscriptReading>;
        function Probe() {
            reading = useTranscriptReading({
                adapter: { key: 'account/session', read: () => read, save: vi.fn(), wireId: wire, wireSeq: () => 1 },
                items: [], inverted: false, isAtLatest: true,
                listRef: { current: { scrollToEnd, scrollToOffset } }, viewportRef: { current: null },
                expanded: [], restoreExpanded: () => {},
            });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe />); });
        reading!.jumpLatest();
        await act(async () => { resolveRead(saved); await read; });
        await reading!.layout();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('ignores a persisted restore that resolves after a Web wheel claims the viewport', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const saved: ReadingState = { version: 1, anchorId: 'wire2', anchorSeq: 2, offset: -30, expandedGroupIds: [], followLatest: false };
        let resolveRead!: (state: ReadingState) => void;
        const read = new Promise<ReadingState>((resolve) => { resolveRead = resolve; });
        const save = vi.fn();
        const scrollToOffset = vi.fn();
        const list = { current: { scrollToOffset, scrollToIndex: vi.fn() } };
        const viewport = { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } };
        const items = [{ type: 'message', id: 'wire2-replayed', message: msg('wire2-replayed') }] as any;
        let reading: ReturnType<typeof useTranscriptReading>;
        function Probe() {
            reading = useTranscriptReading({
                adapter: { key: 'account/session', read: () => read, save, wireId: wire, wireSeq: () => 2 },
                items,
                inverted: true,
                isAtLatest: false,
                listRef: list as any,
                viewportRef: viewport as any,
                expanded: [],
                restoreExpanded: () => {},
            });
            return <TranscriptReadingContext.Provider value={reading.markers}>
                <TranscriptReadingMarker messageId="wire2-replayed"><></></TranscriptReadingMarker>
            </TranscriptReadingContext.Provider>;
        }
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<Probe />, {
                createNodeMock: () => ({ measureInWindow: (cb: any) => cb(0, 150, 800, 200) }),
            });
        });
        reading!.cancelRestore();
        await act(async () => { await reading!.capture(); });
        await act(async () => { resolveRead(saved); await read; });
        await act(async () => { await reading!.layout(); });
        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ anchorId: 'wire2', followLatest: false }));
        act(() => renderer.unmount());
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('does not re-arm a stale persisted anchor when projection changes after a Web wheel', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const saved: ReadingState = { version: 1, anchorId: 'wire2', anchorSeq: 2, offset: -30, expandedGroupIds: [], followLatest: false };
        const scrollToOffset = vi.fn();
        const list = { current: { scrollToOffset, scrollToIndex: vi.fn() } };
        const viewport = { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } };
        let items = [{ type: 'message', id: 'wire2-replayed', message: msg('wire2-replayed') }] as any;
        let reading: ReturnType<typeof useTranscriptReading>;
        const adapter = { key: 'account/session', read: async () => saved, save: vi.fn(), wireId: wire, wireSeq: () => 2 };
        function Probe(_props: { revision?: number }) {
            reading = useTranscriptReading({
                adapter,
                items,
                inverted: true,
                isAtLatest: false,
                listRef: list as any,
                viewportRef: viewport as any,
                expanded: [],
                restoreExpanded: () => {},
            });
            return <TranscriptReadingContext.Provider value={reading.markers}>
                <TranscriptReadingMarker messageId="wire2-replayed"><></></TranscriptReadingMarker>
            </TranscriptReadingContext.Provider>;
        }
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<Probe />, {
                createNodeMock: () => ({ measureInWindow: (cb: any) => cb(0, 150, 800, 200) }),
            });
        });
        scrollToOffset.mockClear();
        reading!.cancelRestore();
        items = [...items, { type: 'message', id: 'older', message: msg('older') }];
        await act(async () => { renderer.update(<Probe revision={1} />); });
        await act(async () => { await reading!.layout(); });
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('lets a Web wheel take ownership before a pending restore can snap the viewport back', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const saved: ReadingState = { version: 1, anchorId: 'wire2', anchorSeq: 2, offset: -30, expandedGroupIds: [], followLatest: false };
        const scrollToOffset = vi.fn();
        const list = { current: { scrollToOffset, scrollToIndex: vi.fn() } };
        const viewport = { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } };
        const items = [{ type: 'message', id: 'wire2-replayed', message: msg('wire2-replayed') }] as any;
        let reading: ReturnType<typeof useTranscriptReading>;
        function Probe() {
            reading = useTranscriptReading({
                adapter: { key: 'account/session', read: async () => saved, save: vi.fn(), wireId: wire, wireSeq: () => 2 },
                items,
                inverted: true,
                isAtLatest: false,
                listRef: list as any,
                viewportRef: viewport as any,
                expanded: [],
                restoreExpanded: () => {},
            });
            return <TranscriptReadingContext.Provider value={reading.markers}>
                <TranscriptReadingMarker messageId="wire2-replayed"><></></TranscriptReadingMarker>
            </TranscriptReadingContext.Provider>;
        }
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<Probe />, {
                createNodeMock: () => ({ measureInWindow: (cb: any) => cb(0, 150, 800, 200) }),
            });
        });
        await act(async () => {
            handleTranscriptWebWheel(
                { shiftKey: false, deltaX: 0, deltaY: 120, preventDefault: () => {} },
                { scrollTop: 400 },
                reading!.cancelRestore,
            );
            await reading!.layout();
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('keeps Shift-horizontal Web wheels mapped onto the transcript vertical axis', () => {
        const node = { scrollTop: 100 };
        let claimed = false;
        let prevented = false;
        handleTranscriptWebWheel(
            { shiftKey: true, deltaX: 40, deltaY: 0, preventDefault: () => { prevented = true; } },
            node,
            () => { claimed = true; },
        );
        expect(claimed).toBe(true);
        expect(node.scrollTop).toBe(140);
        expect(prevented).toBe(true);
    });

    it('keeps group expansion when replay or an older boundary changes its rendered group ID', () => {
        const saved = expandedGroupKeys([group('old-group', ['wire2'])], new Set(), wire);
        expect(saved).toEqual([JSON.stringify(['tool-group', ['wire2']])]);
        expect(groupIsExpanded(group('new-group', ['wire1-replayed', 'wire2-replayed']), saved, wire)).toBe(true);
        expect(findAnchorIndex([group('new-group', ['wire1-replayed', 'wire2-replayed'])], 'wire2', wire)).toBe(0);
        const stable = (id: string) => id === 'synthetic-permission' ? null : 'one-wire-multiple-blocks';
        expect(findAnchorIndex([group('synthetic', ['synthetic-permission']), group('real', ['block1', 'block2'])], 'one-wire-multiple-blocks', stable)).toBe(1);
    });

    it('restores using measured row coordinates and persists the stable wire anchor with its signed viewport offset', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const saved = { version: 1, anchorId: 'wire2', anchorSeq: 2, offset: -30, expandedGroupIds: [], followLatest: false } as const;
        const save = vi.fn(); const scrollToOffset = vi.fn(); const scrollToIndex = vi.fn();
        let reading: any;
        const adapter = { key: 'account/session', read: async () => ({ ...saved, expandedGroupIds: [] }), save,
            wireId: wire, wireSeq: () => 2 };
        const list = { current: { scrollToOffset, scrollToIndex } };
        const viewport = { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } };
        let items = [{ type: 'message', id: 'wire2-replayed', message: msg('wire2-replayed') }] as any;
        let rowY = 150;
        function Probe(_props: { revision?: number }) {
            reading = useTranscriptReading({ adapter, items, inverted: true, isAtLatest: false, listRef: list as any,
                viewportRef: viewport as any, expanded: [], restoreExpanded: () => {} });
            return <TranscriptReadingContext.Provider value={reading.markers}>
                <TranscriptReadingMarker messageId="wire2-replayed"><></></TranscriptReadingMarker>
            </TranscriptReadingContext.Provider>;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe />, {
            createNodeMock: () => ({ measureInWindow: (cb: any) => cb(0, rowY, 800, 200) }),
        }); });
        await act(async () => { reading.scroll(400, 500); await reading.layout(); });
        // Current y 150 should become viewport y 100 - 30. Inverted offset
        // increases move the item down, so the measured correction is -80.
        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 320, animated: false });
        await act(async () => { reading.scroll(400, 500); await reading.capture(); });
        // Reprojection/prepend moves the same wire-backed row by 100px.
        rowY = 250;
        items = [...items, { type: 'message', id: 'older', message: msg('older') }];
        await act(async () => { renderer.update(<Probe revision={1} />); });
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 300, animated: false });
        act(() => renderer.unmount());
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ anchorId: 'wire2', anchorSeq: 2, offset: 50, followLatest: false }));
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('discards an old account reading-state load after the component changes owners', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let finish!: (value: any) => void;
        const restored = vi.fn();
        const ownerA = { key: 'a', read: () => new Promise<any>(resolve => { finish = resolve; }), save: vi.fn(), wireId: wire, wireSeq: () => 1 };
        const ownerB = { ...ownerA, key: 'b', read: async () => null, save: vi.fn() };
        const empty = { current: null };
        function Probe(props: { adapter: any }) {
            useTranscriptReading({ adapter: props.adapter, items: [], inverted: true, isAtLatest: false,
                listRef: empty, viewportRef: empty, expanded: [], restoreExpanded: restored });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe adapter={ownerA} />); });
        await act(async () => { renderer.update(<Probe adapter={ownerB} />); });
        restored.mockClear();
        await act(async () => { finish({ version: 1, anchorId: 'secret-a', anchorSeq: 1, offset: 0, expandedGroupIds: ['a'] }); });
        expect(restored).not.toHaveBeenCalled();
        expect(ownerA.save).not.toHaveBeenCalled(); expect(ownerB.save).not.toHaveBeenCalled();
        act(() => renderer.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('keeps expansion after its first wire member is trimmed and removes all aliases on manual collapse', () => {
        const original = group('random-old', ['A', 'B', 'C']);
        const saved = expandedGroupKeys([original], new Set(), wire);
        const trimmed = group('random-new', ['B-replayed', 'C-replayed']);
        expect(groupIsExpanded(trimmed, saved, wire)).toBe(true);
        const collapsed = setGroupExpansion(saved, trimmed, false, wire);
        expect(groupIsExpanded(original, collapsed, wire)).toBe(false);
        expect(groupIsExpanded(trimmed, collapsed, wire)).toBe(false);
    });

    it('bounds expansion aliases and group records while accepting legacy one-member keys', () => {
        const legacy = [JSON.stringify(['tool-group', 'A'])];
        const item = group('replayed', ['A', 'B']);
        expect(groupIsExpanded(item, legacy, wire)).toBe(true);
        expect(setGroupExpansion(legacy, item, false, wire)).toEqual([]);
        const large = group('large', Array.from({ length: 400 }, (_, i) => `member-${i}`));
        const aliases = setGroupExpansion([], large, true, wire);
        expect(JSON.parse(aliases[0])[1]).toHaveLength(300);
        expect(setGroupExpansion(aliases, large, true, wire)).toBe(aliases);
        let keys: string[] = [];
        for (let i = 0; i < 300; i++) keys = setGroupExpansion(keys, group(`g${i}`, [`wire${i}`]), true, wire);
        expect(keys).toHaveLength(256);
        expect(groupIsExpanded(group('last', ['wire299']), keys, wire)).toBe(true);
    });

    it('does not apply a second async correction after Web owns the retained projection offset', async () => {
        let reading: ReturnType<typeof useTranscriptReading>;
        const scrollToOffset = vi.fn();
        const adapter = { key: 'sync-web', read: async () => null, save: vi.fn(), wireId: () => 'wire', wireSeq: () => 1 };
        function Probe({ version }: { version: number }) {
            reading = useTranscriptReading({ adapter, items: [{ type: 'message', id: `row-${version}`, message: msg(`row-${version}`) }],
                inverted: false, isAtLatest: false, synchronousAnchoring: true,
                listRef: { current: { scrollToOffset } },
                viewportRef: { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } },
                expanded: [], restoreExpanded: () => {} });
            return null;
        }
        let renderer: any; let rowY = 100;
        await act(async () => { renderer = TestRenderer.create(<Probe version={0} />); });
        reading!.markers!.register('row-0', { measureInWindow: (cb: any) => cb(0, rowY, 800, 200) }, 0);
        reading!.cancelRestore('older');
        await reading!.capture();
        reading!.pin();
        reading!.adjustOffset(30900);
        rowY = 424; // An intermediate async measurement is not the position owner.
        await act(async () => { renderer.update(<Probe version={1} />); });
        await reading!.layout();
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it.each([false, true])('restores the second cross-screen block of one wire after rendered IDs are regenerated (sync Web: %s)', async synchronousAnchoring => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let saved: any = null; let reading: any;
        const adapter = { key: 'same-owner', read: async () => saved, save: (state: any) => { saved = state; },
            wireId: () => 'shared-wire', wireSeq: () => 10, blockKey: (id: string) => id.endsWith('first') ? 'text:0' : 'text:1' };
        const scrollToOffset = vi.fn(); const list = { current: { scrollToOffset, scrollToIndex: vi.fn() } };
        const viewport = { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } };
        let firstY = -1400; let secondY = -100;
        function Probe(props: { prefix: string }) {
            const items = ['first', 'second'].map(suffix => ({ type: 'message', id: `${props.prefix}-${suffix}`, message: msg(`${props.prefix}-${suffix}`) })) as any;
            reading = useTranscriptReading({ adapter, items, inverted: false, isAtLatest: false, listRef: list, viewportRef: viewport,
                synchronousAnchoring,
                expanded: [], restoreExpanded: () => {} });
            return <TranscriptReadingContext.Provider value={reading.markers}>{items.map((item: any) =>
                <TranscriptReadingMarker key={item.id} messageId={item.id}><label>{item.id}</label></TranscriptReadingMarker>)}</TranscriptReadingContext.Provider>;
        }
        const nodeMock = (element: any) => ({ measureInWindow: (cb: any) => cb(0,
            element.props.children?.props?.children?.endsWith('first') ? firstY : secondY, 800, 1200) });
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Probe prefix="old" />, { createNodeMock: nodeMock }); });
        await act(async () => { reading.scroll(1800, 900); await reading.capture(); });
        expect(saved).toMatchObject({ anchorId: 'shared-wire', offset: -200 });
        act(() => renderer.unmount());
        firstY = -1100; secondY = 200;
        await act(async () => { renderer = TestRenderer.create(<Probe prefix="new-random" />, { createNodeMock: nodeMock }); });
        await act(async () => { reading.scroll(1800, 900); await reading.layout(); });
        // Only the second block needs a +300px scroll correction, not -1000px
        // from applying its offset to the offscreen first block.
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 2100, animated: false });
        act(() => renderer.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });
});
