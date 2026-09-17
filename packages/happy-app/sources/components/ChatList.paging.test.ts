import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    messages: [] as any[],
    hasMoreOlder: false,
    isLoadingOlder: false,
    session: null as any,
}));
vi.hoisted(() => {
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        ActivityIndicator: host('ActivityIndicator'),
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Platform: { OS: 'ios' },
        Pressable: host('Pressable'),
        View: host('View'),
    };
});

// The list's props are captured so a test can drive layout and scroll
// events the way the real FlashList would.
const flash = vi.hoisted(() => ({ props: null as any }));
vi.mock('@shopify/flash-list', async () => {
    const ReactModule = await import('react');
    return {
        FlashList: (props: any) => {
            flash.props = props;
            return ReactModule.createElement(
                'FlashList',
                null,
                props.data.map((item: any, index: number) => ReactModule.createElement(
                    ReactModule.Fragment,
                    { key: props.keyExtractor?.(item, index) ?? index },
                    props.renderItem({ item, index }),
                )),
            );
        },
    };
});

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { divider: 'divider', shadow: { color: 'shadow', opacity: 1 }, surface: 'surface', text: 'text' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: (t: any) => unknown) => factory(theme) } };
});
vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Octicons: (props: any) => ReactModule.createElement('Octicons', props) };
});
vi.mock('@/sync/storage', () => ({
    storage: (selector: (storeState: any) => any) => selector({
        sessions: state.session ? { [state.session.id]: state.session } : {},
    }),
    useSession: () => state.session,
    useSessionMessages: () => ({
        messages: state.messages,
        hasMoreOlder: state.hasMoreOlder,
        isLoadingOlder: state.isLoadingOlder,
    }),
    useSetting: () => true,
}));
vi.mock('@/sync/storageTypes', () => ({}));
vi.mock('@/sync/typesMessage', () => ({}));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/utils/toolDisplay', () => ({ isInteractiveQuestionToolName: () => false }));
const syncMock = vi.hoisted(() => ({ loadOlderMessages: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: syncMock }));
vi.mock('@/sync/controlHandoff', () => ({ resolveControlMode: () => 'agent' }));
vi.mock('@/sync/rig', () => ({ usesControlledSessionUi: () => false }));
vi.mock('@/utils/agentTurnCopy', () => ({ buildAgentTurnCopyTextByMessageId: () => new Map() }));
vi.mock('@/utils/perfLog', () => ({ perfSince: vi.fn(), useCommitPerf: vi.fn() }));
vi.mock('./MessageView', async () => {
    const ReactModule = await import('react');
    return { MessageView: (props: any) => ReactModule.createElement('MessageView', { id: props.message.id }) };
});
vi.mock('./AgentWorkGroupHeader', async () => {
    const ReactModule = await import('react');
    return { AgentWorkGroupHeader: (props: any) => ReactModule.createElement('AgentWorkGroupHeader', props) };
});
vi.mock('./ChatFooter', async () => {
    const ReactModule = await import('react');
    return { ChatFooter: (props: any) => ReactModule.createElement('ChatFooter', props) };
});

import { ChatList } from './ChatList';

// Messages are newest first. Ids carry the seq so the oldest rendered seq
// says how deep into history the list currently reaches.
function tool(seq: number, id = `t${seq}`): any {
    return {
        kind: 'tool-call', id, localId: null, createdAt: seq * 10 + 1,
        tool: { name: 'Bash', state: 'completed', input: {}, createdAt: 0, startedAt: 0, completedAt: 1, description: '' },
        children: [],
    };
}
function turn(seq: number): any[] {
    return [
        { kind: 'agent-text', id: `a${seq}`, localId: null, createdAt: seq * 10 + 2, text: 'done' },
        tool(seq),
        { kind: 'user-text', id: `u${seq}`, localId: null, createdAt: seq * 10, text: 'go' },
    ];
}
function turns(newestSeq: number, count: number): any[] {
    const out: any[] = [];
    for (let seq = newestSeq; seq > newestSeq - count; seq--) out.push(...turn(seq));
    return out;
}
function oldestRenderedSeq(renderer: any): number {
    const ids = renderer.root.findAllByType('MessageView').map((node: any) => node.props.id as string);
    return Math.min(...ids.map((id: string) => Number(id.slice(1))));
}

const renderers: any[] = [];
// A fresh session object each time: ChatList is memoized on its props, and
// in the app the store hook re-renders it; the mock here has no subscription.
function render(renderer?: any) {
    const element = React.createElement(ChatList, { session: { ...state.session }, active: true });
    if (renderer) {
        act(() => renderer.update(element));
        return renderer;
    }
    let next: any;
    act(() => { next = create(element); });
    renderers.push(next);
    return next;
}
// A reader dragging up to the oldest rendered message.
function scrollToOldest(renderer: any) {
    act(() => {
        flash.props.onLoad?.();
        flash.props.onLayout?.({ nativeEvent: { layout: { height: 800 } } });
        flash.props.onContentSizeChange?.(0, 100000);
    });
    act(() => {
        flash.props.onScrollBeginDrag?.();
        flash.props.onScroll?.({ nativeEvent: {
            contentOffset: { y: 99000 }, contentSize: { height: 100000 }, layoutMeasurement: { height: 800 },
        } });
    });
    render(renderer);
}
// Drags up page after page until the window stops growing (store exhausted).
function scrollUntilStill(renderer: any) {
    let previous = -1;
    for (let guard = 0; guard < 10 && flash.props.data.length !== previous; guard++) {
        previous = flash.props.data.length;
        scrollToOldest(renderer);
    }
}
function serverPage(renderer: any, page: any[]) {
    act(() => { state.isLoadingOlder = true; });
    render(renderer);
    state.messages = [...state.messages, ...page];
    act(() => { state.isLoadingOlder = false; });
    render(renderer);
}

afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    state.messages = [];
    state.hasMoreOlder = false;
    state.isLoadingOlder = false;
    state.session = null;
    syncMock.loadOlderMessages.mockClear();
});

describe('ChatList history paging', () => {
    it('pages the history the store already holds into a freshly opened chat', () => {
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        state.messages = turns(1000, 40);
        const renderer = render();
        expect(oldestRenderedSeq(renderer)).toBe(981);

        scrollUntilStill(renderer);
        expect(oldestRenderedSeq(renderer)).toBe(961);
        expect(syncMock.loadOlderMessages).not.toHaveBeenCalled();
    });

    it('keeps fetching when a server page brings no turn opener', () => {
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        state.messages = turns(1000, 40);
        state.hasMoreOlder = true;
        const renderer = render();
        scrollUntilStill(renderer);
        expect(oldestRenderedSeq(renderer)).toBe(961);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(1);

        // A long agent turn: one hundred tool calls, no prompt among them.
        const toolsOnly: any[] = [];
        for (let seq = 960; seq > 860; seq--) toolsOnly.push(tool(seq));
        serverPage(renderer, toolsOnly);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(2);
        expect(oldestRenderedSeq(renderer)).toBe(961);

        // The next page carries the prompt that opened it: everything renders.
        serverPage(renderer, turns(860, 5));
        expect(oldestRenderedSeq(renderer)).toBe(860);

        // And the reader can go on paging past it.
        scrollUntilStill(renderer);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(3);
    });

    it('lets the next drag ask again after a fetch that brought nothing', () => {
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        state.messages = turns(1000, 40);
        state.hasMoreOlder = true;
        const renderer = render();
        scrollUntilStill(renderer);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(1);

        // The request failed: loading flipped, no messages, still more on the server.
        serverPage(renderer, []);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(1);

        scrollToOldest(renderer);
        expect(syncMock.loadOlderMessages).toHaveBeenCalledTimes(2);
    });
});
