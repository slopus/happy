// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { ConversationTranscript } from './ConversationTranscript';
import { ChatList } from './ChatList';
import type { ReadingState } from '@/sync/localHistoryStore';
import type { Message } from '@/sync/typesMessage';
import type { SessionTextPreview } from '@/sync/sessionTextStream';

const sessionState = vi.hoisted(() => ({
    messages: [] as Message[], isLoaded: true, hasMoreOlder: true, isLoadingOlder: false,
    hasMoreNewer: false, isLoadingNewer: false, isAtLatest: true,
}));
const liveState = vi.hoisted(() => ({ previews: [] as SessionTextPreview[], renderEdges: false }));
vi.mock('@/sync/sessionTextStream', () => ({ useSessionTextPreviews: () => liveState.previews }));
const grouped = vi.hoisted(() => ({ items: null as any[] | null, renderRows: false,
    renders: [] as Array<{ id: string; expanded: boolean }> }));
vi.mock('@/sync/storage', () => ({
    useSessionMessages: () => sessionState,
    useSession: () => ({ id: 'session', metadata: null }),
    useSetting: () => true,
}));
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn(), getLocalHistoryScope: () => null, getHistoryBoundarySeq: () => null } }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({}) }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('./ChatFooter', () => ({ ChatFooter: 'ChatFooter' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));

vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: vi.fn() }) },
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props: any, ref: any) => React.createElement('FlatList', { ...props, ref },
        liveState.renderEdges ? props.ListHeaderComponent : null,
        grouped.renderRows ? props.data.map((item: any) => React.cloneElement(props.renderItem({ item }), { key: item.renderKey })) : null,
        liveState.renderEdges ? props.ListFooterComponent : null)),
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    ScrollView: 'ScrollView',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('@expo/vector-icons', () => ({ Octicons: 'Octicons' }));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: Record<string, unknown>) => object) => factory({
            colors: {
                divider: '#444',
                shadow: { color: '#000', opacity: 0.2 },
                surface: '#111',
                text: '#fff',
                textSecondary: '#aaa',
                fab: { background: '#fff' },
            },
        }),
    },
    useUnistyles: () => ({ theme: { colors: { text: '#fff' } } }),
}));
vi.mock('@/hooks/useGroupedMessages', () => ({
    filterSupersededUserMessages: (messages: Message[]) => messages,
    useGroupedMessages: (messages: Message[]) => grouped.items ?? messages.map((message) => ({ type: 'message', id: message.id, message })),
    isSessionTurnActive: () => false,
}));
vi.mock('@/utils/messageForkPoint', () => ({ getAgentMessageForkTargets: () => new Map() }));
vi.mock('@/modal/components/BaseModal', () => ({ BaseModal: 'BaseModal' }));
vi.mock('@/text', () => ({ t: (key: string, params?: { count: number }) => params ? `${key}:${params.count}` : key }));
vi.mock('./MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./ToolGroupView', () => ({
    AgentWorkGroupView: (props: any) => {
        grouped.renders.push({ id: props.group.id, expanded: props.expanded });
        return React.createElement('AgentWorkGroupView', props);
    },
    ToolGroupView: 'ToolGroupView',
}));
vi.mock('./AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));

const userMessage = (id: string): Message => ({ kind: 'user-text', id, localId: null, createdAt: 1, text: id });
const scroll = (renderer: any) => act(() => renderer.root.findByType('FlatList').props.onScroll({
    nativeEvent: { contentOffset: { y: 2000 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 } },
}));
const byId = (renderer: any, testID: string) => renderer.root.findByProps({ testID });
const reachOlder = (list: any) => { list.props.onScrollBeginDrag(); list.props.onStartReached(); };
const installFrameQueue = () => {
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
    return async () => {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => { pending.forEach(callback => callback(0)); });
    };
};

describe('ConversationTranscript older history pagination', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let flushFrame: ReturnType<typeof installFrameQueue>;

    beforeEach(() => {
        flushFrame = installFrameQueue();
        liveState.previews = []; liveState.renderEdges = false;
        grouped.items = null;
        grouped.renders = [];
        grouped.renderRows = false;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const originalConsoleError = console.error;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        (Platform as any).OS = 'web';
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('keeps an overlapping folded group mounted when paging changes both boundary members', async () => {
        const adapter = { key: 'group-window', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const group = (ids: string[]) => ({ type: 'agent-work-group', id: 'group-' + ids[0],
            messages: ids.map(userMessage), hasPendingPermission: false });
        grouped.items = [group(['3', '2', '1'])];
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="group-window" messages={[]} reading={adapter} />); });
        const before = byId(renderer, 'conversation-transcript-list').props.data[0].renderKey;
        grouped.items = [group(['5', '4', '3'])];
        await act(async () => renderer.update(<ConversationTranscript metadata={null}
            sessionId="group-window" messages={[userMessage('5')]} reading={adapter} />));
        expect(byId(renderer, 'conversation-transcript-list').props.data[0].renderKey).toBe(before);
        act(() => renderer.unmount());
    });

    it.each([true, false])('never transiently expands a newly identified historical group (reading: %s)', async durable => {
        grouped.renderRows = true;
        const adapter = { key: 'fold-first-render', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id) };
        const group = (ids: string[]) => ({ type: 'agent-work-group', id: 'group-' + ids[0],
            messages: ids.map(userMessage), hasPendingPermission: false });
        grouped.items = [group(['3', '2', '1'])];
        const render = (messages: Message[]) => <ConversationTranscript metadata={null} sessionId="fold-first-render"
            messages={messages} reading={durable ? adapter : undefined} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([])); });
        grouped.renders = [];
        grouped.items = [group(['5', '4', '3'])];
        await act(async () => renderer.update(render([userMessage('5')])));
        expect(grouped.renders.length).toBeGreaterThan(0);
        expect(grouped.renders.every(row => row.expanded === false)).toBe(true);
        act(() => renderer.unmount());
    });

    it('keeps a manually collapsed permission group closed through replayed group IDs', async () => {
        grouped.renderRows = true;
        const adapter = { key: 'permission-replay', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: () => 1 };
        const group = (id: string) => ({ type: 'agent-work-group', id,
            messages: [userMessage('member')], hasPendingPermission: true });
        grouped.items = [group('first-id')];
        const render = () => <ConversationTranscript metadata={null} sessionId="permission-replay"
            messages={[userMessage('member')]} reading={adapter} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render()); });
        const row = () => renderer.root.findByType('AgentWorkGroupView').props;
        expect(row().expanded).toBe(true);
        act(() => row().onToggle());
        expect(row().expanded).toBe(false);
        grouped.renders = [];
        grouped.items = [group('replayed-id')];
        await act(async () => renderer.update(render()));
        expect(grouped.renders.length).toBeGreaterThan(0);
        expect(grouped.renders.every(row => !row.expanded)).toBe(true);
        act(() => row().onToggle());
        expect(row().expanded).toBe(true);
        act(() => renderer.unmount());
    });

    it('preserves measured scroll extent when screen-external rows are evicted and reloaded', async () => {
        const adapter = { key: 'extent-window', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[]) => <ConversationTranscript metadata={null} sessionId="extent-window"
            messages={rows} reading={adapter} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(messages)); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        act(() => {
            for (const item of list().props.data) {
                list().props.renderItem({ item }).props.onLayout({ nativeEvent: { layout: { height: 100 } } });
            }
        });
        expect(list().props.getItemLayout(null, 5).offset).toBe(500);
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        expect(list().props.getItemLayout(null, 0).offset).toBe(500);
        await act(async () => renderer.update(render(messages)));
        expect(list().props.getItemLayout(null, 5).offset).toBe(500);
        act(() => renderer.unmount());
    });

    it('settles restored row height against its placeholder and clears stale extent on resize', async () => {
        const adapter = { key: 'extent-resize', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[], more = true) => <ConversationTranscript metadata={null} sessionId="extent-resize"
            messages={rows} reading={adapter} hasMoreOlder={more} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(messages)); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        act(() => { for (const item of list().props.data) list().props.renderItem({ item }).props.onLayout({
            nativeEvent: { layout: { height: 100 } } }); });
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        await act(async () => renderer.update(render(messages.slice(0, 6))));
        expect(list().props.getItemLayout(null, 0).offset).toBe(400);
        act(() => list().props.renderItem({ item: list().props.data[0] }).props.onLayout({ nativeEvent: { layout: { height: 400 } } }));
        expect(list().props.getItemLayout(null, 0).offset).toBe(100);
        expect(list().props.getItemLayout(null, 1).offset).toBe(500);
        act(() => list().props.onLayout({ nativeEvent: { layout: { width: 900, height: 800 } } }));
        expect(list().props.getItemLayout(null, 0).offset).toBe(0);
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        expect(list().props.getItemLayout(null, 0).offset).toBeGreaterThan(0);
        await act(async () => renderer.update(render(messages.slice(0, 5), false)));
        expect(list().props.getItemLayout(null, 0).offset).toBe(0);
        act(() => renderer.unmount());
    });

    it('offers explicit continuation at the hard limit without dropping viewport protection on automatic retry', async () => {
        const newer = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null} sessionId="capacity"
            messages={[userMessage('1')]} hasMoreNewer isAtLatest={false} newerError="history-window-capacity" onLoadNewer={newer} />); });
        act(() => byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
            contentOffset: { y: 0 }, contentSize: { height: 800 }, layoutMeasurement: { height: 800 },
        } }));
        const button = byId(renderer, 'history-newer-retry');
        expect(button.findByType('Text').props.children).toBe('common.continue');
        act(() => button.props.onPress());
        expect(newer).toHaveBeenCalledWith(undefined);
        act(() => renderer.unmount());
    });

    it('settles a batch of restored measurements without losing negative compensation', async () => {
        const adapter = { key: 'extent-batch', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[]) => <ConversationTranscript metadata={null} sessionId="extent-batch"
            messages={rows} reading={adapter} hasMoreOlder />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(messages)); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        const measure = (index: number, height: number) => act(() => list().props.renderItem({ item: list().props.data[index] })
            .props.onLayout({ nativeEvent: { layout: { height } } }));
        for (let i = 0; i < 10; i++) measure(i, i < 3 ? 60 : i < 5 ? 160 : 100);
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        await act(async () => renderer.update(render(messages.slice(0, 7))));
        expect(list().props.getItemLayout(null, 0).offset).toBe(180);
        measure(0, 400);
        expect(list().props.getItemLayout(null, 0).offset).toBe(0);
        measure(1, 100);
        expect(list().props.getItemLayout(null, 0).offset).toBe(0);
        expect(list().props.getItemLayout(null, 2).offset).toBe(500);
        act(() => renderer.unmount());
    });

    it('clears restoration debt on an unchanged first layout so later expansion adds real height', async () => {
        const adapter = { key: 'extent-expand', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[]) => <ConversationTranscript metadata={null} sessionId="extent-expand"
            messages={rows} reading={adapter} hasMoreOlder />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(messages)); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        const measure = (index: number, height: number) => act(() => list().props.renderItem({ item: list().props.data[index] })
            .props.onLayout({ nativeEvent: { layout: { height } } }));
        for (let i = 0; i < 10; i++) measure(i, 100);
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        await act(async () => renderer.update(render(messages.slice(0, 6))));
        measure(0, 100);
        measure(0, 500);
        expect(list().props.getItemLayout(null, 0).offset).toBe(400);
        expect(list().props.getItemLayout(null, 1).offset).toBe(900);
        act(() => renderer.unmount());
    });

    it('continues to protect the current viewport on ordinary network-error retry', async () => {
        const newer = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null} sessionId="offline"
            messages={[userMessage('1')]} hasMoreNewer isAtLatest={false} newerError="offline" onLoadNewer={newer} />); });
        act(() => byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
            contentOffset: { y: 0 }, contentSize: { height: 800 }, layoutMeasurement: { height: 800 },
        } }));
        act(() => byId(renderer, 'history-newer-retry').props.onPress());
        expect(newer).toHaveBeenCalledWith(expect.any(Function));
        act(() => renderer.unmount());
    });

    it('uses mounted row measurements when an initial width event cleared the height cache', async () => {
        const adapter = { key: 'extent-dom', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id), blockKey: () => 'text:0' };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[]) => <ConversationTranscript metadata={null} sessionId="extent-dom"
            messages={rows} reading={adapter} hasMoreOlder />;
        let renderer: any;
        let mountedRows: any[] = [];
        const node = { querySelectorAll: () => mountedRows, addEventListener() {}, removeEventListener() {} };
        await act(async () => { renderer = TestRenderer.create(render(messages), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node } : null,
        }); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        mountedRows = list().props.data.map((item: any) => ({ dataset: { transcriptKey: item.renderKey },
            getBoundingClientRect: () => ({ height: 100 }) }));
        await act(async () => renderer.update(render(messages.slice(0, 5))));
        expect(list().props.getItemLayout(null, 0).offset).toBe(500);
        act(() => renderer.unmount());
    });

    it.each((['older', 'newer'] as const).flatMap(direction =>
        (['error', 'reverse', 'filled', 'unchanged', 'capturing-reverse', 'wire-only'] as const).map(stop => ({ direction, stop }))))(
        'refills known $direction spacer after a sparse page and stops on $stop', async ({ direction, stop }) => {
        const node = document.createElement('div');
        Object.defineProperties(node, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
        node.scrollTop = direction === 'newer' ? 100 : 500;
        const load = vi.fn();
        let holdCapture = false;
        const held: (() => void)[] = [];
        const adapter = { key: 'spacer-refill', read: async () => null, save: () => {},
            wireId: (id: string) => id, wireSeq: (id: string) => Number(id) };
        const messages = Array.from({ length: 10 }, (_, i) => userMessage(String(10 - i)));
        const render = (rows: Message[], error?: string, cursor = rows.length) => <ConversationTranscript metadata={null} sessionId="spacer-refill"
            messages={rows} reading={stop === 'capturing-reverse' ? adapter : undefined} hasMoreOlder hasMoreNewer isAtLatest={false}
            olderCursor={stop === 'wire-only' ? cursor : undefined} newerCursor={stop === 'wire-only' ? cursor : undefined}
            onLoadOlder={direction === 'older' ? load : undefined} onLoadNewer={direction === 'newer' ? load : undefined}
            olderError={direction === 'older' ? error : undefined} newerError={direction === 'newer' ? error : undefined} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(messages), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node }
                : { measureInWindow: (cb: any) => {
                    const finish = () => cb(0, 0, 800, 400);
                    if (holdCapture) held.push(finish); else finish();
                } },
        }); });
        const list = () => byId(renderer, 'conversation-transcript-list');
        act(() => { for (const item of list().props.data) list().props.renderItem({ item }).props.onLayout({
            nativeEvent: { layout: { height: 100 } } }); });
        const page = (count: number) => direction === 'newer' ? messages.slice(10 - count) : messages.slice(0, count);
        await act(async () => renderer.update(render(page(5))));
        await act(async () => node.dispatchEvent(new WheelEvent('wheel', { deltaY: direction === 'newer' ? 1 : -1, cancelable: true })));
        expect(load).toHaveBeenCalledTimes(1);
        holdCapture = stop === 'capturing-reverse';
        await act(async () => renderer.update(render(page(stop === 'wire-only' ? 5 : 6), undefined, 6)));
        await flushFrame(); await flushFrame();
        if (stop === 'capturing-reverse') {
            expect(held.length).toBeGreaterThan(0);
            await act(async () => node.dispatchEvent(new WheelEvent('wheel', { deltaY: direction === 'newer' ? -1 : 1, cancelable: true })));
            holdCapture = false;
            await act(async () => { held.splice(0).forEach(finish => finish()); });
            expect(load).toHaveBeenCalledTimes(1);
            act(() => renderer.unmount());
            return;
        }
        expect(load).toHaveBeenCalledTimes(2);
        if (stop === 'wire-only') {
            await act(async () => renderer.update(render(page(5), undefined, 6)));
            await flushFrame(); await flushFrame();
            expect(load).toHaveBeenCalledTimes(2);
            act(() => renderer.unmount());
            return;
        }
        if (stop === 'reverse') await act(async () => node.dispatchEvent(new WheelEvent('wheel', {
            deltaY: direction === 'newer' ? -1 : 1, cancelable: true,
        })));
        await act(async () => renderer.update(render(page(stop === 'filled' ? 10 : stop === 'unchanged' ? 6 : 7),
            stop === 'error' ? 'history-window-capacity' : undefined)));
        await flushFrame(); await flushFrame();
        expect(load).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    // Dispatch browser events on the actual scroll node: RN Web never emits
    // onScrollBeginDrag. Only its onScroll payload is bridged by this fixture.
    it.each(['keyboard', 'scrollbar', 'touch'] as const)('claims %s DOM navigation, preserves reading and allows one page per fresh gesture', async gesture => {
        const node = document.createElement('div');
        Object.defineProperties(node, {
            scrollHeight: { value: 5000 }, clientHeight: { value: 800 },
            clientWidth: { value: 784 }, offsetWidth: { value: 800 },
        });
        node.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 800, width: 800, height: 800, x: 0, y: 0, toJSON() {} });
        const older = vi.fn(); const newer = vi.fn(); const scrollToEnd = vi.fn();
        let renderer: any;
        const render = (id: string, latest = true) => <ConversationTranscript metadata={null} sessionId="dom-navigation"
            messages={[userMessage(id)]} hasMoreOlder hasMoreNewer isAtLatest={latest}
            onLoadOlder={older} onLoadNewer={newer} />;
        await act(async () => { renderer = TestRenderer.create(render('one'), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node, scrollToEnd } : null,
        }); });
        const emitScroll = (y: number) => {
            node.scrollTop = y;
            node.dispatchEvent(new Event('scroll'));
            byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
                contentOffset: { y }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
        };
        const touch = (type: string, y: number) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: [{ clientY: y, clientX: 100 }] });
            node.dispatchEvent(event);
        };
        const intent = (direction: 'older' | 'newer') => {
            if (gesture === 'keyboard') node.dispatchEvent(new KeyboardEvent('keydown', { key: direction === 'older' ? 'Home' : 'End', bubbles: true }));
            if (gesture === 'scrollbar') {
                // A scrollbar gesture needs actual displacement; pressing an
                // already-reached edge alone has no older/newer direction.
                node.scrollTop = direction === 'older' ? 100 : 4100;
                node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 792, clientY: 400, bubbles: true }));
            }
            if (gesture === 'touch') { touch('touchstart', 200); touch('touchmove', direction === 'older' ? 300 : 100); }
        };
        act(() => emitScroll(0));
        expect(older).not.toHaveBeenCalled();
        act(() => intent('older'));
        act(() => emitScroll(0));
        expect(older).toHaveBeenCalledOnce();
        scrollToEnd.mockClear();
        act(() => renderer.update(render('two')));
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(800, 5500));
        act(() => emitScroll(0));
        expect(older).toHaveBeenCalledOnce();
        expect(scrollToEnd).not.toHaveBeenCalled();
        act(() => intent('older'));
        act(() => emitScroll(0));
        expect(older).toHaveBeenCalledTimes(2);
        act(() => intent('older'));
        act(() => emitScroll(0));
        expect(older).toHaveBeenCalledTimes(3); // same boundary can be retried
        act(() => renderer.update(render('two', false)));
        act(() => emitScroll(4200));
        expect(newer).not.toHaveBeenCalled();
        act(() => intent('newer'));
        act(() => emitScroll(4200));
        expect(newer).toHaveBeenCalledOnce();
        act(() => renderer.update(render('three', false)));
        act(() => emitScroll(4200));
        expect(newer).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it.each(['wheel', 'shift-wheel', 'keyboard', 'touch', 'scrollbar'] as const)('keeps %s pagination in the requested direction when both preload zones overlap', async gesture => {
        const node = document.createElement('div');
        Object.defineProperties(node, { scrollHeight: { value: 1980 }, clientHeight: { value: 925 }, clientWidth: { value: 784 } });
        node.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 925, width: 800, height: 925, x: 0, y: 0, toJSON() {} });
        node.scrollTop = 500;
        let targetOffset = 500;
        const older = vi.fn(); const newer = vi.fn();
        let renderer: any;
        const render = (id: string, latest: boolean) => <ConversationTranscript metadata={null} sessionId="overlap"
            messages={[userMessage(id)]} hasMoreOlder hasMoreNewer isAtLatest={latest}
            onLoadOlder={older} onLoadNewer={newer} />;
        await act(async () => { renderer = TestRenderer.create(render('latest', true), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node } : null,
        }); });
        const intent = (delta: number) => {
            targetOffset = node.scrollTop + delta;
            if (gesture === 'wheel') node.dispatchEvent(new WheelEvent('wheel', { deltaY: delta }));
            if (gesture === 'shift-wheel') node.dispatchEvent(new WheelEvent('wheel', { shiftKey: true, deltaX: delta, deltaY: -Math.sign(delta) * 0.1 }));
            if (gesture === 'scrollbar') node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 792, clientY: 400 }));
            if (gesture === 'keyboard') node.dispatchEvent(new KeyboardEvent('keydown', { key: delta > 0 ? 'ArrowDown' : 'ArrowUp' }));
            if (gesture === 'touch') {
                for (const [type, y] of [['touchstart', 400], ['touchmove', 400 - delta]] as const) {
                    const event = new Event(type);
                    Object.defineProperty(event, 'touches', { value: [{ clientX: 100, clientY: y }] });
                    node.dispatchEvent(event);
                }
            }
        };
        const emitScroll = () => {
            node.scrollTop = targetOffset;
            byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
                contentOffset: { y: targetOffset }, contentSize: { height: 1980 }, layoutMeasurement: { height: 925 },
            } });
        };
        // Already at latest: a down gesture must not consume its intent by
        // loading older just because the short grouped history is near the top.
        act(() => { intent(100); emitScroll(); byId(renderer, 'conversation-transcript-list').props.onStartReached(); });
        expect(older).not.toHaveBeenCalled();
        expect(newer).not.toHaveBeenCalled();
        await act(async () => { renderer.update(render('historical', false)); });
        if (gesture === 'scrollbar') {
            act(() => {
                intent(0);
                emitScroll();
                byId(renderer, 'conversation-transcript-list').props.onStartReached();
                byId(renderer, 'conversation-transcript-list').props.onEndReached();
            });
            expect(older).not.toHaveBeenCalled();
            expect(newer).not.toHaveBeenCalled();
        }
        act(() => { intent(-100); emitScroll(); byId(renderer, 'conversation-transcript-list').props.onEndReached(); });
        expect(older).toHaveBeenCalledOnce();
        expect(newer).not.toHaveBeenCalled();
        // Layout and vendor boundary callbacks cannot reverse/rearm a gesture.
        await act(async () => { renderer.update(render('previous-page', false)); });
        act(() => { emitScroll(); byId(renderer, 'conversation-transcript-list').props.onEndReached(); });
        expect(newer).not.toHaveBeenCalled();
        act(() => { intent(100); emitScroll(); byId(renderer, 'conversation-transcript-list').props.onStartReached(); });
        expect(older).toHaveBeenCalledOnce();
        expect(newer).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it.each(['anchor', 'latest'] as const)('discards unused DOM navigation intent before a programmatic %s jump', async target => {
        const node = document.createElement('div');
        Object.defineProperties(node, { scrollHeight: { value: 5000 }, clientHeight: { value: 800 } });
        node.scrollTop = 2500;
        const older = vi.fn();
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="jump" messages={[userMessage('one')]} hasMoreOlder onLoadOlder={older} />, {
            createNodeMock: (element: any) => element.type === 'FlatList'
                ? { getScrollableNode: () => node, scrollToIndex: vi.fn(), scrollToEnd: vi.fn() } : null,
        }); });
        act(() => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' })));
        scroll(renderer);
        if (target === 'anchor') {
            act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
            const sheet = renderer.root.findByType('BaseModal').props.children.props;
            act(() => sheet.onSelect(sheet.anchors[0]));
        } else act(() => byId(renderer, 'conversation-scroll-to-bottom').props.onPress());
        act(() => byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
            contentOffset: { y: 0 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
        } }));
        expect(older).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('does not claim typing, prevented keys, background clicks or touch taps as navigation', async () => {
        const node = document.createElement('div');
        Object.defineProperties(node, { scrollHeight: { value: 5000 }, clientHeight: { value: 800 }, clientWidth: { value: 784 } });
        node.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 800, width: 800, height: 800, x: 0, y: 0, toJSON() {} });
        const input = document.createElement('textarea'); node.append(input);
        const older = vi.fn(); const scrollToEnd = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="non-navigation" messages={[userMessage('one')]} hasMoreOlder onLoadOlder={older} />, {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node, scrollToEnd } : null,
        }); });
        scrollToEnd.mockClear();
        act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
            node.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
            const prevented = new KeyboardEvent('keydown', { key: 'PageUp', cancelable: true }); prevented.preventDefault(); node.dispatchEvent(prevented);
            node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100 }));
            const tap = new Event('touchstart'); Object.defineProperty(tap, 'touches', { value: [{ clientX: 10, clientY: 10 }] }); node.dispatchEvent(tap);
            node.dispatchEvent(new Event('touchend'));
            byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
                contentOffset: { y: 0 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
            byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(800, 5500);
        });
        await flushFrame();
        expect(older).not.toHaveBeenCalled();
        expect(scrollToEnd).toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('wires Web wheel ownership to the native scroll node and removes the listener on cleanup', async () => {
        const saved: ReadingState = { version: 1, anchorId: 'wire2', anchorSeq: 2, offset: -30, expandedGroupIds: [], followLatest: false };
        let resolveRead!: (state: ReadingState) => void;
        const read = new Promise<ReadingState>((resolve) => { resolveRead = resolve; });
        const scrollToOffset = vi.fn();
        const listeners = new Map<string, (event: any) => void>();
        const node = {
            scrollTop: 100,
            addEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.set(type, listener)),
            removeEventListener: vi.fn((type: string, listener: (event: any) => void) => {
                if (listeners.get(type) === listener) listeners.delete(type);
            }),
        };
        const adapter = {
            key: 'owner/session', read: () => read, save: vi.fn(),
            wireId: (id: string) => id.replace(/-replayed$/, ''), wireSeq: () => 2,
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} messages={[userMessage('wire2-replayed')]}
                    reading={adapter} isAtLatest={false} />,
                { createNodeMock: (element: any) => element.type === 'FlatList'
                    ? { ...node, getScrollableNode: () => node, scrollToOffset, scrollToIndex: vi.fn() }
                    : { measureInWindow: (cb: any) => cb(0, element.props.onLayout ? 150 : 100, 800, 200) } },
            );
        });
        expect(node.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
        const wheel = listeners.get('wheel');
        expect(wheel).toBeDefined();
        wheel!({ shiftKey: false, deltaX: 0, deltaY: 120, preventDefault: vi.fn() });
        const preventDefault = vi.fn();
        wheel!({ shiftKey: true, deltaX: 40, deltaY: 0, preventDefault });
        expect(node.scrollTop).toBe(140);
        expect(preventDefault).toHaveBeenCalledOnce();
        await act(async () => { resolveRead(saved); await read; });
        await act(async () => { byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(100, 2000); });
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
        expect(node.removeEventListener).toHaveBeenCalledWith('wheel', wheel);
        expect(listeners.has('wheel')).toBe(false);
    });

    it('does not register the Web wheel listener on native platforms', async () => {
        (Platform as any).OS = 'ios';
        const node = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[]} />, {
                createNodeMock: (element: any) => element.type === 'FlatList' ? { getScrollableNode: () => node } : null,
            });
        });
        expect(node.addEventListener).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('loads older history after native initial loading leaves the transcript shorter than its viewport', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const messages = [userMessage('latest')];
        const render = (loading: boolean) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(true)); });
        const list = byId(renderer, 'conversation-transcript-list');
        expect(typeof list.props.onLayout).toBe('function');
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 320);
        });
        expect(onLoadOlder).not.toHaveBeenCalled();

        await act(async () => { renderer.update(render(false)); });
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('waits for a fresh native measurement when newer content changes but the oldest boundary stays the same', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const render = (messages: Message[], loading: boolean) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([userMessage('latest')], true)); });
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 320);
        });

        const withNewerContent = [userMessage('new-latest'), userMessage('latest')];
        await act(async () => { renderer.update(render(withNewerContent, true)); });
        await act(async () => { renderer.update(render(withNewerContent, false)); });
        expect(onLoadOlder).not.toHaveBeenCalled();

        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 900));
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('reuses an underfilled native measurement after same-height content settles without a size callback', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const render = (messages: Message[], loading: boolean) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([userMessage('latest')], true)); });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 320);
        });

        const sameHeightReplacement = [userMessage('latest')];
        await act(async () => { renderer.update(render(sameHeightReplacement, true)); });
        await flushFrame();
        await flushFrame();
        await act(async () => { renderer.update(render(sameHeightReplacement, false)); });
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('waits for a delayed taller native measurement instead of promoting by elapsed wall time', async () => {
        vi.useFakeTimers();
        installFrameQueue();
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const render = (messages: Message[], loading: boolean) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([userMessage('latest')], true)); });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 320);
        });

        const tallerContent = [userMessage('new-latest'), userMessage('latest')];
        await act(async () => { renderer.update(render(tallerContent, true)); });
        await act(async () => { vi.advanceTimersByTime(50); });
        await act(async () => { renderer.update(render(tallerContent, false)); });
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 900));
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('loads consecutive underfilled native pages and stops when older history is exhausted', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const render = (messages: Message[], loading: boolean, hasMore = true) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder={hasMore} isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([userMessage('latest')], false)); });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 240);
        });
        expect(onLoadOlder).toHaveBeenCalledTimes(1);

        const firstPage = [userMessage('latest'), userMessage('older-1')];
        await act(async () => { renderer.update(render(firstPage, true)); });
        await act(async () => { renderer.update(render(firstPage, false)); });
        expect(onLoadOlder).toHaveBeenCalledTimes(1);
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 520));
        expect(onLoadOlder).toHaveBeenCalledTimes(2);

        const exhausted = [...firstPage, userMessage('oldest')];
        await act(async () => { renderer.update(render(exhausted, true)); });
        await act(async () => { renderer.update(render(exhausted, false, false)); });
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 700));
        expect(onLoadOlder).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it('retries the same native history boundary when collapsing a group leaves no scroll range', async () => {
        (Platform as any).OS = 'android';
        const messages = [userMessage('latest')];
        grouped.items = [{
            type: 'tool-group', id: 'tools', messages,
            hasRunning: false, hasPendingPermission: true,
        }];
        const onLoadOlder = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                    hasMoreOlder isLoadingOlder={false} onLoadOlder={onLoadOlder} />,
            );
        });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 1200);
            list.props.onEndReached();
        });
        expect(onLoadOlder).toHaveBeenCalledOnce();

        const groupRow = () => byId(renderer, 'conversation-transcript-list').props
            .renderItem({ item: grouped.items![0] }).props.children.props;
        expect(groupRow().expanded).toBe(true);
        act(() => groupRow().onToggle());
        expect(groupRow().expanded).toBe(false);
        act(() => byId(renderer, 'conversation-transcript-list').props.onEndReached());
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 320));

        expect(onLoadOlder).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it.each([
        ['android', 900, 'still scrollable native content'],
        ['web', 320, 'underfilled Web content'],
    ])('does not release the same history boundary for %s after a group collapses', async (platform, collapsedHeight) => {
        (Platform as any).OS = platform;
        const requestOlder = (list: any) => platform === 'web' ? reachOlder(list) : list.props.onEndReached();
        const messages = [userMessage('latest')];
        grouped.items = [{
            type: 'tool-group', id: 'tools', messages,
            hasRunning: false, hasPendingPermission: true,
        }];
        const onLoadOlder = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                    hasMoreOlder isLoadingOlder={false} onLoadOlder={onLoadOlder} />,
            );
        });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 1200);
            requestOlder(list);
        });
        expect(onLoadOlder).toHaveBeenCalledOnce();

        const groupRow = () => {
            const row = byId(renderer, 'conversation-transcript-list').props
                .renderItem({ item: grouped.items![0] }).props.children;
            return platform === 'web' ? row.props.children.props : row.props;
        };
        expect(groupRow().expanded).toBe(true);
        act(() => groupRow().onToggle());
        expect(groupRow().expanded).toBe(false);
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, collapsedHeight));
        act(() => requestOlder(byId(renderer, 'conversation-transcript-list')));

        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('does not eagerly load an underfilled Web transcript', async () => {
        const onLoadOlder = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} sessionId="session" messages={[userMessage('latest')]}
                    hasMoreOlder onLoadOlder={onLoadOlder} />,
            );
        });
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 240);
        });
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('waits for a fresh native content measurement before loading a changed history boundary', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        const render = (messages: Message[]) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                hasMoreOlder onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render([userMessage('latest')])); });
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 320);
        });
        expect(onLoadOlder).toHaveBeenCalledOnce();

        await act(async () => { renderer.update(render([userMessage('latest'), userMessage('older')])); });
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(400, 900));
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('does not load older native history when content exactly fills the viewport', async () => {
        (Platform as any).OS = 'android';
        const onLoadOlder = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} sessionId="session" messages={[userMessage('latest')]}
                    hasMoreOlder onLoadOlder={onLoadOlder} />,
            );
        });
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 800 } } });
            list.props.onContentSizeChange(400, 800);
        });
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('uses bounded non-inverted virtualization on Web and keeps native inversion', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[userMessage('web')]} />);
        });
        expect(byId(renderer, 'conversation-transcript-list').props.disableVirtualization).toBe(false);
        expect(byId(renderer, 'conversation-transcript-list').props.inverted).toBe(false);
        expect(byId(renderer, 'conversation-transcript-list').props.windowSize).toBe(5);

        await act(async () => {
            renderer.update(<ConversationTranscript metadata={null} messages={[userMessage('public')]} inverted={false} />);
        });
        expect(byId(renderer, 'conversation-transcript-list').props.disableVirtualization).toBe(false);

        (Platform as any).OS = 'ios';
        await act(async () => {
            renderer.update(<ConversationTranscript metadata={null} messages={[userMessage('native')]} />);
        });
        expect(byId(renderer, 'conversation-transcript-list').props.disableVirtualization).toBe(false);
        expect(byId(renderer, 'conversation-transcript-list').props.inverted).toBe(true);
        act(() => renderer.unmount());
    });

    it('restarts Web latest-following after a user message is sent', async () => {
        const scrollToEnd = vi.fn(); let renderer: any;
        const render = (request: number, id: string) => <ConversationTranscript metadata={null}
            sessionId="send-follow" messages={[userMessage(id)]} followLatestRequest={request} />;
        await act(async () => { renderer = TestRenderer.create(render(0, 'before'), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToEnd } : null,
        }); });
        scrollToEnd.mockClear();
        act(() => {
            const list = byId(renderer, 'conversation-transcript-list');
            list.props.onScrollBeginDrag();
            list.props.onScroll({ nativeEvent: {
                contentOffset: { y: 400 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
        });
        await act(async () => { renderer.update(render(1, 'after')); });
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
        act(() => renderer.unmount());
    });

    it('coalesces streaming layout updates into one Web latest scroll per frame', async () => {
        const scrollToEnd = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="stream-follow" messages={[userMessage('stream')]} />, {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToEnd } : null,
        }); });
        scrollToEnd.mockClear();
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onContentSizeChange(800, 1000);
            list.props.onContentSizeChange(800, 1100);
            list.props.onContentSizeChange(800, 1200);
        });
        expect(scrollToEnd).not.toHaveBeenCalled();
        await flushFrame();
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it.each(['web', 'android'])('updates the real ChatList live edge without pulling an older reader to latest (%s)', async platform => {
        (Platform as any).OS = platform;
        liveState.renderEdges = true;
        sessionState.messages = [userMessage('stream-user')];
        sessionState.isAtLatest = true;
        sessionState.isLoaded = true;
        sessionState.hasMoreOlder = false;
        liveState.previews = [{ sessionId: 'session', turnId: 'turn', itemId: 'item', createdAt: 2, text: 'First' }];
        const scrollToEnd = vi.fn(); const scrollToOffset = vi.fn(); let renderer: any;
        const render = () => <ChatList session={{ id: 'session', metadata: null } as any} />;
        await act(async () => { renderer = TestRenderer.create(render(), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToEnd, scrollToOffset } : null,
        }); });
        expect(renderer.root.findByProps({ testID: 'session-stream-preview-text' }).props.children).toBe('First');
        const list = byId(renderer, 'conversation-transcript-list');
        const historyRows = list.props.data;
        act(() => {
            list.props.onScrollBeginDrag();
            list.props.onScroll({ nativeEvent: {
                contentOffset: { y: 1000 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
        });
        scrollToEnd.mockClear(); scrollToOffset.mockClear();
        liveState.previews = [{ ...liveState.previews[0], text: 'First second third' }];
        await act(async () => renderer.update(render()));
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(800, 5100));
        await flushFrame();
        expect(renderer.root.findByProps({ testID: 'session-stream-preview-text' }).props.children).toBe('First second third');
        expect(byId(renderer, 'conversation-transcript-list').props.data).toEqual(historyRows);
        expect(scrollToEnd).not.toHaveBeenCalled();
        expect(scrollToOffset).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('drops a pending Web latest scroll when the user starts scrolling', async () => {
        const scrollToEnd = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="stream-pause" messages={[userMessage('stream')]} />, {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToEnd } : null,
        }); });
        scrollToEnd.mockClear();
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onContentSizeChange(800, 1000);
            list.props.onScrollBeginDrag();
        });
        await flushFrame();
        expect(scrollToEnd).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('resumes Web latest-following after the user returns to the bottom', async () => {
        const scrollToEnd = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="stream-resume" messages={[userMessage('stream')]} />, {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToEnd } : null,
        }); });
        scrollToEnd.mockClear();
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => {
            list.props.onScrollBeginDrag();
            list.props.onScroll({ nativeEvent: {
                contentOffset: { y: 400 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
            list.props.onScroll({ nativeEvent: {
                contentOffset: { y: 4200 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 800 },
            } });
            // A Web layout update can report the same scrollTop while the
            // transcript grows. It must not cancel following after the user
            // has returned to the latest edge.
            list.props.onScroll({ nativeEvent: {
                contentOffset: { y: 4200 }, contentSize: { height: 5300 }, layoutMeasurement: { height: 800 },
            } });
            list.props.onContentSizeChange(800, 1200);
        });
        await flushFrame();
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
        act(() => renderer.unmount());
    });

    it('exposes unmeasured Web targets and replaces estimates with bounded row measurements', async () => {
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            messages={[userMessage('new'), userMessage('old')]} />); });
        let list = byId(renderer, 'conversation-transcript-list');
        expect(list.props.getItemLayout(list.props.data, 1)).toMatchObject({ index: 1, offset: 160, length: 160 });
        const row = list.props.renderItem({ item: list.props.data[0] });
        act(() => row.props.onLayout({ nativeEvent: { layout: { height: 321 } } }));
        list = byId(renderer, 'conversation-transcript-list');
        expect(list.props.getItemLayout(list.props.data, 1)).toMatchObject({ offset: 321 });
        act(() => list.props.onLayout({ nativeEvent: { layout: { width: 600, height: 800 } } }));
        list = byId(renderer, 'conversation-transcript-list');
        expect(list.props.getItemLayout(list.props.data, 1)).toMatchObject({ offset: 160 });
        act(() => renderer.unmount());
    });

    it('preserves an image row key through pagination without expanding the synchronous render region', async () => {
        grouped.items = Array.from({ length: 15 }, (_, index) => ({
            type: 'message',
            id: `before-${index}`,
            message: userMessage(`before-${index}`),
        }));
        grouped.items[14] = {
            type: 'image-group',
            id: 'stable-image',
            messages: [userMessage('stable-image')],
            presentation: 'compact',
            pendingCount: 0,
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[]} />);
        });
        const beforeList = byId(renderer, 'conversation-transcript-list');
        const imageKey = beforeList.props.keyExtractor(beforeList.props.data.find((item: any) => item.id === 'stable-image'));
        expect(beforeList.props.initialNumToRender).toBe(10);

        grouped.items = [
            ...grouped.items.slice(0, 7),
            ...Array.from({ length: 4 }, (_, index) => ({
                type: 'message',
                id: `inserted-${index}`,
                message: userMessage(`inserted-${index}`),
            })),
            ...grouped.items.slice(7),
        ];
        await act(async () => {
            renderer.update(<ConversationTranscript metadata={null} messages={[userMessage('pagination')]} />);
        });

        const afterList = byId(renderer, 'conversation-transcript-list');
        expect(afterList.props.initialNumToRender).toBe(10);
        expect(afterList.props.keyExtractor(afterList.props.data.find((item: any) => item.id === 'stable-image'))).toBe(imageKey);
        act(() => renderer.unmount());
    });

    it('does not force an eager full render for a Web transcript without image rows', async () => {
        grouped.items = Array.from({ length: 15 }, (_, index) => ({
            type: 'message',
            id: `text-${index}`,
            message: userMessage(`text-${index}`),
        }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[]} />);
        });

        expect(byId(renderer, 'conversation-transcript-list').props.initialNumToRender).toBe(10);
        act(() => renderer.unmount());
    });

    it('hides standalone browser evidence from the transcript before its invocation loads', async () => {
        const invoke: Message = { kind: 'tool-call', id: 'skill', localId: null, createdAt: 1, children: [],
            tool: { name: 'Skill', input: { skill: 'ego-browser' }, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 1, description: null } };
        const frame: Message = { ...invoke, id: 'frame', createdAt: 2, tool: { ...invoke.tool,
            name: 'file', input: { ref: 'frame.png', name: 'frame.png', source: 'browser_step', browserStep: { label: 'Verified', runId: 'run', skillName: 'ego-browser' } } } };
        const reference: Message = { ...frame, id: 'reference', tool: { ...frame.tool, input: { ref: 'ref.png', name: 'ref.png', source: 'user' } } };
        let renderer: any;
        const render = (messages: Message[], sessionId: string | undefined = 'session') => <ConversationTranscript metadata={null} sessionId={sessionId} messages={messages} groupToolCalls={false} />;
        await act(async () => { renderer = TestRenderer.create(render([frame, reference])); });
        const ids = () => byId(renderer, 'conversation-transcript-list').props.data.map((item: any) => item.id);
        // A complete browser-step identity is sufficient to form a standalone
        // Browser Steps run. Its image becomes a lightweight Skill entry while
        // the matching invocation is still loading, keeping progress reachable.
        expect(ids()).toEqual(['reference', 'frame']);
        act(() => renderer.update(render([frame, reference, invoke])));
        expect(ids()).toEqual(['skill', 'reference']);
        act(() => renderer.update(<ConversationTranscript metadata={null} messages={[frame, reference, invoke]} groupToolCalls={false} />));
        expect(ids()).toEqual(['skill', 'reference', 'frame']);
        act(() => renderer.unmount());
    });

    it('preserves React row keys across history replay without conflating blocks of one wire message', async () => {
        const reading = { key: 'session', read: async () => null, save: vi.fn(),
            wireId: () => 'same-wire', wireSeq: () => 1,
            blockKey: (id: string) => id.endsWith('second') ? 'text:1' : 'text:0' };
        const render = (prefix: string) => <ConversationTranscript metadata={null}
            messages={[userMessage(`${prefix}-first`), userMessage(`${prefix}-second`)]} reading={reading} />;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render('original')); });
        const keys = () => {
            const list = renderer.root.findByType('FlatList');
            return list.props.data.map(list.props.keyExtractor);
        };
        const before = keys();
        expect(new Set(before).size).toBe(2);
        await act(async () => { renderer.update(render('replayed')); });
        expect(keys()).toEqual(before);
        act(() => renderer.unmount());
    });

    it('prefetches the next older page two viewports before the visual top', async () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const onLoadOlder = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} messages={[]} onLoadOlder={onLoadOlder} />,
            );
        });

        const list = renderer.root.findByType('FlatList');
        expect(list.props.onEndReachedThreshold).toBe(2);
        act(() => list.props.onStartReached());
        expect(onLoadOlder).not.toHaveBeenCalled();
        act(() => reachOlder(list));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('does not retry the same older wire boundary when history replay changes reducer ids', async () => {
        const onLoadOlder = vi.fn();
        const reading = {
            key: 'session', read: async () => null, save: vi.fn(),
            wireId: (id: string) => id.replace('-replayed', ''),
            wireSeq: () => 1,
        };
        const render = (id: string) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={[userMessage(id)]}
                reading={reading} hasMoreOlder onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render('oldest')); });
        act(() => reachOlder(byId(renderer, 'conversation-transcript-list')));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);

        act(() => renderer.update(render('oldest-replayed')));
        act(() => reachOlder(byId(renderer, 'conversation-transcript-list')));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('lets a new Web wheel retry an older boundary whose previous load made no progress', async () => {
        const onLoadOlder = vi.fn();
        const listeners = new Map<string, (event: any) => void>();
        const node = {
            scrollTop: 0,
            scrollHeight: 2000,
            clientHeight: 800,
            addEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.set(type, listener)),
            removeEventListener: vi.fn(),
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ConversationTranscript metadata={null} sessionId="session" messages={[userMessage('oldest')]}
                    hasMoreOlder onLoadOlder={onLoadOlder} />,
                { createNodeMock: (element: any) => element.type === 'FlatList'
                    ? { ...node, getScrollableNode: () => node }
                    : null },
            );
        });
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => reachOlder(list));
        act(() => reachOlder(list));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);

        act(() => listeners.get('wheel')!({ shiftKey: false, deltaX: 0, deltaY: -120, preventDefault: vi.fn() }));
        expect(onLoadOlder).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it('uses the current transcript direction when wheel retries after an in-place layout change', async () => {
        const onLoadOlder = vi.fn();
        const listeners = new Map<string, (event: any) => void>();
        const node = {
            scrollTop: 1200,
            scrollHeight: 2000,
            clientHeight: 800,
            addEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.set(type, listener)),
            removeEventListener: vi.fn(),
        };
        const render = (inverted: boolean) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={[userMessage('oldest')]}
                inverted={inverted} hasMoreOlder onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(render(true), {
                createNodeMock: (element: any) => element.type === 'FlatList'
                    ? { ...node, getScrollableNode: () => node }
                    : null,
            });
        });
        act(() => renderer.update(render(false)));
        node.scrollTop = 0;
        act(() => listeners.get('wheel')!({ shiftKey: false, deltaX: 0, deltaY: -120, preventDefault: vi.fn() }));
        expect(onLoadOlder).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('uses the current history adapter when boundary identity changes without new messages', async () => {
        const onLoadOlder = vi.fn();
        const messages = [userMessage('rendered-oldest')];
        const adapter = (wireId: string) => ({
            key: wireId,
            read: async () => null,
            save: vi.fn(),
            wireId: () => wireId,
            wireSeq: () => 1,
        });
        const render = (reading: ReturnType<typeof adapter>) => (
            <ConversationTranscript metadata={null} sessionId="session" messages={messages}
                reading={reading} hasMoreOlder onLoadOlder={onLoadOlder} />
        );
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render(adapter('wire-a'))); });
        act(() => reachOlder(byId(renderer, 'conversation-transcript-list')));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);

        act(() => renderer.update(render(adapter('wire-b'))));
        act(() => reachOlder(byId(renderer, 'conversation-transcript-list')));
        expect(onLoadOlder).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it('keeps partial counts and an open sheet live until the last history page arrives', async () => {
        const onLoadOlder = vi.fn();
        const messages = ['u5', 'u4', 'u3'].map(userMessage);
        let renderer: any;
        const render = (more: boolean, loading = false, current = messages) => (
            <ConversationTranscript metadata={null} messages={current} hasMoreOlder={more}
                isLoadingOlder={loading} onLoadOlder={onLoadOlder} />
        );
        await act(async () => { renderer = TestRenderer.create(render(true)); });
        // No eager history fetch just to produce a total.
        expect(onLoadOlder).not.toHaveBeenCalled();
        scroll(renderer);
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe('3+');
        act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
        expect(byId(renderer, 'anchor-list-subtitle').props.children).toBe('session.anchorsLoadedSubtitle:3');
        act(() => byId(renderer, 'anchor-list-load-older').props.onPress());
        expect(onLoadOlder).toHaveBeenCalledTimes(1);
        act(() => renderer.update(render(true, true)));
        expect(byId(renderer, 'anchor-list-load-older').props.disabled).toBe(true);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'common.loading')).toBe(true);

        act(() => renderer.update(render(false, false, [...messages, userMessage('u2'), userMessage('u1')])));
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe(5);
        expect(byId(renderer, 'anchor-list-subtitle').props.children).toBe('session.anchorsSubtitle:5');
        expect(renderer.root.findByType('BaseModal').props.children.props.anchors.map((anchor: any) => anchor.id))
            .toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
        expect(renderer.root.findAllByProps({ testID: 'anchor-list-load-older' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('offers older history even when the latest page has no user anchors', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<ConversationTranscript metadata={null}
                messages={[{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'working' }]}
                hasMoreOlder onLoadOlder={vi.fn()} />);
        });
        scroll(renderer);
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe('0+');
        act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
        expect(byId(renderer, 'anchor-list-load-older')).toBeDefined();
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'session.anchorsEmpty')).toBe(false);
        act(() => renderer.unmount());
    });

    it.each([true, false])('resolves a selected anchor after incoming messages shift its index (inverted=%s)', async (inverted) => {
        let renderer: any;
        const scrollToIndex = vi.fn(); const scrollToEnd = vi.fn();
        const render = (messages: Message[]) => <ConversationTranscript metadata={null} sessionId="anchor-session" messages={messages} inverted={inverted} />;
        await act(async () => {
            renderer = TestRenderer.create(render([userMessage('u2'), userMessage('u1')]), {
                createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToIndex, scrollToEnd } : null,
            });
        });
        scroll(renderer);
        act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
        const oldSheet = renderer.root.findByType('BaseModal').props.children.props;
        const selected = oldSheet.anchors.find((anchor: any) => anchor.id === 'u2');
        act(() => renderer.update(render([userMessage('u3'), userMessage('u2'), userMessage('u1'), userMessage('u0')])));
        act(() => oldSheet.onSelect(selected));
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: inverted ? 1 : 2, animated: true, viewPosition: 0.5 });
        scrollToEnd.mockClear();
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(800, 4000));
        expect(scrollToEnd).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('closes the anchor sheet on session changes', async () => {
        let renderer: any;
        const render = (sessionId: string) => <ConversationTranscript metadata={null} sessionId={sessionId} messages={[userMessage('u1')]} />;
        await act(async () => { renderer = TestRenderer.create(render('one')); });
        scroll(renderer);
        act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
        expect(renderer.root.findAllByType('BaseModal')).toHaveLength(1);
        act(() => renderer.update(render('two')));
        expect(renderer.root.findAllByType('BaseModal')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('passes restored-cache and pagination completeness from ChatList to the live anchors', async () => {
        Object.assign(sessionState, {
            messages: [userMessage('u1')], isLoaded: false, hasMoreOlder: false, isLoadingOlder: false,
        });
        let renderer: any;
        const render = () => <ChatList session={{ id: 'session', metadata: null } as any} />;
        await act(async () => { renderer = TestRenderer.create(render()); });
        scroll(renderer);
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe('1+');
        act(() => byId(renderer, 'conversation-anchors-button').props.onPress());
        expect(byId(renderer, 'anchor-list-load-older').props.disabled).toBe(true);
        Object.assign(sessionState, { isLoaded: true, hasMoreOlder: true });
        act(() => renderer.update(render()));
        expect(byId(renderer, 'anchor-list-load-older').props.disabled).toBe(false);
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe('1+');
        Object.assign(sessionState, { hasMoreOlder: false });
        act(() => renderer.update(render()));
        expect(byId(renderer, 'conversation-anchors-count').props.children).toBe(1);
        expect(byId(renderer, 'anchor-list-subtitle').props.children).toBe('session.anchorsSubtitle:1');
        act(() => renderer.unmount());
    });

    it('keeps background loading hidden and shows delayed boundary loading without adding list height', async () => {
        vi.useFakeTimers();
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[userMessage('u')]}
            hasMoreOlder isLoadingOlder />); });
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(renderer.root.findAllByProps({ testID: 'history-older-loading' })).toHaveLength(0);
        act(() => byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
            contentOffset: { y: 0 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 800 },
        } }));
        expect(renderer.root.findAllByProps({ testID: 'history-older-loading' })).toHaveLength(0);
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(byId(renderer, 'history-older-loading')).toBeDefined();
        expect(byId(renderer, 'conversation-transcript-list').props.ListFooterComponent).toBeUndefined();
        act(() => renderer.unmount()); vi.useRealTimers();
    });

    it.each([true, false])('loads newer at the historical visual bottom only once per boundary (inverted=%s)', async inverted => {
        const newer = vi.fn(); const older = vi.fn();
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[userMessage('old')]}
            inverted={inverted} isAtLatest={false} hasMoreNewer onLoadNewer={newer} onLoadOlder={older} />); });
        const list = byId(renderer, 'conversation-transcript-list');
        act(() => { list.props.onScrollBeginDrag(); for (let i = 0; i < 3; i++) list.props.onScroll({ nativeEvent: {
            contentOffset: { y: inverted ? 0 : 1200 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 800 },
        } }); });
        expect(newer).toHaveBeenCalledOnce();
        expect(older).not.toHaveBeenCalled();
        expect(list.props.maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
        act(() => renderer.unmount());
    });

    it('selects latest before scrolling from a historical window', async () => {
        let finish!: () => void;
        const jump = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
        const scrollToEnd = vi.fn(); let renderer: any;
        const render = (latest: boolean) => <ConversationTranscript metadata={null} messages={[userMessage(latest ? 'new' : 'old')]}
            isAtLatest={latest} onJumpToLatest={jump} />;
        await act(async () => { renderer = TestRenderer.create(render(false), { createNodeMock: () => ({ scrollToEnd }) }); });
        act(() => byId(renderer, 'conversation-scroll-to-bottom').props.onPress());
        expect(jump).toHaveBeenCalledOnce(); expect(scrollToEnd).not.toHaveBeenCalled();
        await act(async () => { finish(); renderer.update(render(true)); });
        act(() => byId(renderer, 'conversation-transcript-list').props.onContentSizeChange(100, 2000));
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
        act(() => renderer.unmount());
    });

    it('allows retry when a completed latest request still leaves a historical window', async () => {
        const jump = vi.fn(async () => {});
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="retry-latest" messages={[userMessage('old')]} isAtLatest={false} onJumpToLatest={jump} />); });
        await act(async () => { await byId(renderer, 'conversation-scroll-to-bottom').props.onPress(); });
        await act(async () => { await byId(renderer, 'conversation-scroll-to-bottom').props.onPress(); });
        expect(jump).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it('gates current-turn, footer and latest edit controls in a historical ChatList', async () => {
        Object.assign(sessionState, { isAtLatest: false }); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ChatList session={{ id: 'session', metadata: null } as any} />); });
        const transcript = renderer.root.findByType((ConversationTranscript as any).type).props;
        expect(transcript.currentTurnActive).toBe(false);
        expect(transcript.canEditLatestUserMessage).toBe(false);
        expect(transcript.visualBottom).toBeNull();
        act(() => renderer.unmount()); Object.assign(sessionState, { isAtLatest: true });
    });

    it('offers explicit retry only at a failed reached boundary', async () => {
        const retry = vi.fn(); let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null} messages={[userMessage('u')]}
            hasMoreOlder olderError="offline" onLoadOlder={retry} />); });
        expect(renderer.root.findAllByProps({ testID: 'history-older-retry' })).toHaveLength(0);
        act(() => byId(renderer, 'conversation-transcript-list').props.onScroll({ nativeEvent: {
            contentOffset: { y: 0 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 800 },
        } }));
        expect(retry).not.toHaveBeenCalled();
        act(() => byId(renderer, 'history-older-retry').props.onPress());
        expect(retry).toHaveBeenCalledOnce(); act(() => renderer.unmount());
    });

    it('cancels estimated anchor-scroll retries after switching sessions', async () => {
        vi.useFakeTimers(); const scrollToIndex = vi.fn(); let renderer: any;
        const render = (id: string) => <ConversationTranscript metadata={null} sessionId={id} messages={[userMessage('u')]} />;
        await act(async () => { renderer = TestRenderer.create(render('a'), {
            createNodeMock: (element: any) => element.type === 'FlatList' ? { scrollToIndex, scrollToOffset: vi.fn() } : null,
        }); });
        act(() => byId(renderer, 'conversation-transcript-list').props.onScrollToIndexFailed({ index: 0, averageItemLength: 200 }));
        act(() => renderer.update(render('b')));
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(scrollToIndex).not.toHaveBeenCalled();
        act(() => renderer.unmount()); vi.useRealTimers();
    });

    it('persists expanded A/B/C through trimming A, then persists manual collapse when reopening', async () => {
        const group = (id: string, ids: string[]) => ({ type: 'tool-group', id, messages: ids.map(userMessage), hasRunning: false, hasPendingPermission: false });
        grouped.items = [group('random-original', ['A', 'B', 'C'])];
        let saved: any = { version: 1, anchorId: 'B', anchorSeq: 2, offset: 0, expandedGroupIds: [], followLatest: false };
        const adapter = { key: 'owner/session', read: async () => saved, save: (value: any) => { saved = value; }, wireId: (id: string) => id, wireSeq: () => 2 };
        const render = () => <ConversationTranscript metadata={null} sessionId="session" messages={grouped.items![0].messages}
            reading={adapter} isAtLatest={false} />;
        const row = (renderer: any) => {
            const list = byId(renderer, 'conversation-transcript-list');
            return list.props.renderItem({ item: list.props.data[0] }).props.children.props.children.props;
        };
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render()); });
        expect(row(renderer).expanded).toBe(false);
        act(() => row(renderer).onToggle()); expect(row(renderer).expanded).toBe(true);
        grouped.items = [group('random-trimmed', ['B', 'C'])];
        act(() => renderer.update(render())); expect(row(renderer).expanded).toBe(true);
        act(() => row(renderer).onToggle()); expect(row(renderer).expanded).toBe(false);
        act(() => renderer.unmount());
        grouped.items = [group('random-reopened', ['A', 'B', 'C'])];
        await act(async () => { renderer = TestRenderer.create(render()); });
        expect(row(renderer).expanded).toBe(false);
        act(() => renderer.unmount()); grouped.items = null;
    });
});

it('routes scoped historical message rows to their original session and disables current-session actions', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Platform.OS = 'web'; grouped.renderRows = true; grouped.items = null;
    const old = userMessage('old-message');
    const current = userMessage('new-message');
    const edit = vi.fn(); const fork = vi.fn();
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<ConversationTranscript
        sessionId="new" metadata={null} messages={[current, old]}
        showMessageActions canEditLatestUserMessage onEditUserMessage={edit} onForkFromMessage={fork}
        scopedItems={[
            { type: 'message', id: 'new:new-message', message: current, source: { sessionId: 'new', metadata: null, readOnly: false } },
            { type: 'message', id: 'old:old-message', message: old, source: { sessionId: 'old', metadata: null, readOnly: true } },
        ]} />); });
    const rows = renderer.root.findAllByType('MessageView');
    expect(rows.find((row: any) => row.props.message.id === 'old-message').props).toMatchObject({
        sessionId: 'old', showUserMessageActions: false, canEditUserMessage: false, onEditUserMessage: undefined, onForkFromMessage: undefined,
    });
    expect(rows.find((row: any) => row.props.message.id === 'new-message').props).toMatchObject({
        sessionId: 'new', showUserMessageActions: true, onEditUserMessage: edit, onForkFromMessage: fork,
    });
    act(() => renderer.unmount()); grouped.renderRows = false;
});
