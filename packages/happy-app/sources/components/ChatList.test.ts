import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    appState: 'active' as 'active' | 'inactive' | 'background',
    appStateListeners: [] as Array<(next: 'active' | 'inactive' | 'background') => void>,
    messages: [] as any[],
    hasMoreOlder: false,
    isLoadingOlder: false,
    session: null as any,
    platform: 'ios',
    scrollNode: null as any,
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
        AppState: {
            get currentState() {
                return state.appState;
            },
            addEventListener: (_event: string, listener: (next: typeof state.appState) => void) => {
                state.appStateListeners.push(listener);
                return {
                    remove: () => {
                        state.appStateListeners = state.appStateListeners.filter((candidate) => candidate !== listener);
                    },
                };
            },
        },
        Platform: { get OS() { return state.platform; } },
        Pressable: host('Pressable'),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('@shopify/flash-list', async () => {
    const ReactModule = await import('react');
    return {
        FlashList: (props: any) => {
            const node = state.scrollNode;
            ReactModule.useImperativeHandle(props.ref, () => ({
                getScrollableNode: () => node,
                scrollToOffset: vi.fn(),
            }), [node]);
            return ReactModule.createElement(
            'FlashList',
            props,
            props.data.map((item: any, index: number) => ReactModule.createElement(
                ReactModule.Fragment,
                { key: props.keyExtractor?.(item, index) ?? index },
                props.renderItem({ item, index }),
            )),
            props.ListFooterComponent,
            );
        },
    };
});

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: 'divider',
                shadow: { color: 'shadow', opacity: 1 },
                surface: 'surface',
                text: 'text',
            },
        },
    }),
    StyleSheet: { create: (factory: (theme: any) => unknown) => factory({ colors: {
        divider: 'divider',
        shadow: { color: 'shadow', opacity: 1 },
        surface: 'surface',
        text: 'text',
    } }) },
}));
vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Octicons: (props: any) => ReactModule.createElement('Octicons', props),
        Ionicons: (props: any) => ReactModule.createElement('Ionicons', props),
    };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => state.session,
    useSessionMessages: () => ({ messages: state.messages, hasMoreOlder: state.hasMoreOlder, isLoadingOlder: state.isLoadingOlder }),
    useSetting: () => true,
}));
vi.mock('@/sync/storageTypes', () => ({}));
vi.mock('@/sync/typesMessage', () => ({}));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/utils/toolDisplay', () => ({ isInteractiveQuestionToolName: () => false }));
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/sessionUtils', () => ({ useSessionStatus: () => ({}), formatPathRelativeToHome: (path: string) => path }));
vi.mock('./RoundButton', async () => {
    const ReactModule = await import('react');
    return { RoundButton: (props: any) => ReactModule.createElement('RoundButton', props) };
});
vi.mock('@/sync/controlHandoff', () => ({ resolveControlMode: () => 'agent' }));
vi.mock('@/sync/rig', () => ({ usesControlledSessionUi: () => false }));
vi.mock('@/utils/agentTurnCopy', () => ({ buildAgentTurnCopyTextByMessageId: () => new Map() }));
vi.mock('@/utils/perfLog', () => ({ perfSince: vi.fn(), useCommitPerf: vi.fn() }));
vi.mock('./MessageView', async () => {
    const ReactModule = await import('react');
    return {
        MessageView: (props: any) => ReactModule.createElement('MessageView', {
            id: props.message.id,
            kind: props.message.kind,
        }),
    };
});
vi.mock('./AgentWorkGroupHeader', async () => {
    const ReactModule = await import('react');
    return {
        AgentWorkGroupHeader: (props: any) => ReactModule.createElement('AgentWorkGroupHeader', props),
    };
});
vi.mock('./ChatFooter', async () => {
    const ReactModule = await import('react');
    return { ChatFooter: (props: any) => ReactModule.createElement('ChatFooter', props) };
});

import { ChatList } from './ChatList';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { EmptyMessages } from './EmptyMessages';

const renderers: ReturnType<typeof create>[] = [];

function userMessage(id: string, createdAt: number, localId: string | null = null): any {
    return { kind: 'user-text', id, localId, createdAt, text: 'run tools' };
}

function toolMessage(id: string, createdAt: number): any {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'CodexBash',
            state: 'completed',
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
        },
        children: [],
    };
}

function agentMessage(id: string, createdAt: number): any {
    return { kind: 'agent-text', id, localId: null, createdAt, text: 'done' };
}

function completedTurnMessages(): any[] {
    return [
        agentMessage('agent-final', 5),
        toolMessage('tool-latest', 4),
        toolMessage('tool-earliest', 3),
        userMessage('user', 1),
    ];
}

function twoCompletedTurns(): any[] {
    return [
        agentMessage('agent-new-final', 9),
        toolMessage('tool-new', 8),
        userMessage('user-new', 7),
        agentMessage('agent-old-final', 5),
        toolMessage('tool-old', 4),
        userMessage('user-old', 1),
    ];
}

function renderChat(renderer: ReturnType<typeof create> | undefined, active = true) {
    const element = React.createElement(ChatList, {
        session: { ...state.session },
        active,
    });
    if (renderer) {
        act(() => renderer.update(element));
        return renderer;
    }
    let next!: ReturnType<typeof create>;
    act(() => { next = create(element); });
    renderers.push(next);
    return next;
}

function messageIds(renderer: ReturnType<typeof create>): string[] {
    return renderer.root.findAllByType('MessageView').map((node: any) => node.props.id);
}

afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    state.appState = 'active';
    state.appStateListeners = [];
    state.messages = [];
    state.hasMoreOlder = false;
    state.isLoadingOlder = false;
    state.session = null;
    state.platform = 'ios';
    state.scrollNode = null;
    vi.mocked(sync.loadOlderMessages).mockReset();
    vi.mocked(Modal.alert).mockClear();
});

describe('ChatList automatic history', () => {
    function history(count: number) {
        return Array.from({ length: count }, (_, index) => {
            const seq = 800 - index;
            return [1, 3, 799].includes(seq) ? userMessage(`m${seq}`, seq) : agentMessage(`m${seq}`, seq);
        });
    }
    // A current turn (t1300/t1299) over one long agent turn: final answer
    // t1298, then 1296 rows of work, opened by the prompt at seq 1 — thirteen
    // pages of history for a single collapsed group.
    function longTurn(count: number) {
        return Array.from({ length: count }, (_, index) => {
            const seq = 1300 - index;
            return [1, 1299].includes(seq) ? userMessage(`t${seq}`, seq) : agentMessage(`t${seq}`, seq);
        });
    }
    function thinking(count: number, from = 800) {
        return Array.from({ length: count }, (_, i) => ({ ...agentMessage(`thinking${from - i}`, from - i), isThinking: true }));
    }
    function open(messages = history(600), hasMoreOlder = true) {
        state.messages = messages;
        state.hasMoreOlder = hasMoreOlder;
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        return renderChat(undefined);
    }
    // FlashList's own measurements, in the order they arrive on a real mount.
    // onLoad never fires for zero rows, so it is only emitted when rows exist.
    function layout(renderer: ReturnType<typeof create>, { content = 600, viewport = 600, offset = 0 } = {}) {
        act(() => {
            const list = renderer.root.findByType('FlashList');
            list.props.onLayout({ nativeEvent: { layout: { height: viewport } } });
            list.props.onContentSizeChange(0, content);
            if (list.props.data.length > 0) list.props.onLoad();
            list.props.onScroll({ nativeEvent: { contentOffset: { y: offset }, contentSize: { height: content }, layoutMeasurement: { height: viewport } } });
        });
    }
    function scroll(renderer: ReturnType<typeof create>, offset: number, content = 600, viewport = 600) {
        act(() => {
            renderer.root.findByType('FlashList').props.onScroll({ nativeEvent: { contentOffset: { y: offset }, contentSize: { height: content }, layoutMeasurement: { height: viewport } } });
        });
    }
    // Mimics sync.loadOlderMessages: a call while a page is in flight is a
    // synchronous no-op, and the store's loading flag stays up until the page
    // settles. Each started page gets its own promise; finish/fail act on the
    // most recent unless an earlier page is named.
    function pendingPage() {
        // Resolves with sync's progress boolean: a page that moved the cursor
        // resolves true; a no-op (in flight, exhausted, or `finish(false)`) false.
        const pages: Array<{ finish: (advanced: boolean) => void; fail: (error: Error) => void }> = [];
        vi.mocked(sync.loadOlderMessages).mockImplementation(() => {
            if (state.isLoadingOlder || !state.hasMoreOlder) return Promise.resolve(false);
            state.isLoadingOlder = true;
            return new Promise<boolean>((resolve, reject) => { pages.push({ finish: resolve, fail: reject }); });
        });
        return {
            started: () => pages.length,
            finish: (index = pages.length - 1, advanced = true) => { state.isLoadingOlder = false; pages[index].finish(advanced); },
            fail: (error: Error, index = pages.length - 1) => { state.isLoadingOlder = false; pages[index].fail(error); },
        };
    }
    // The store's own order: rows land and render first, then the loading flag
    // drops and renders, then the promise settles.
    async function settle(renderer: ReturnType<typeof create>, messages: any[], hasMoreOlder: boolean, finish: () => void) {
        await act(async () => {
            state.messages = messages;
            state.hasMoreOlder = hasMoreOlder;
            renderChat(renderer);
            finish();
            renderChat(renderer);
        });
    }
    function headerIds(renderer: ReturnType<typeof create>): string[] {
        return renderer.root.findAllByType('AgentWorkGroupHeader').map((node: any) => node.props.group.id);
    }

    it('renders and folds the downloaded part of a turn whose opener is still on the server', () => {
        const renderer = open();
        expect(messageIds(renderer)).toEqual(['m800', 'm799', 'm798']);
        expect(headerIds(renderer)).toEqual(['work-m798']);
        expect(renderer.root.findAllByType('AgentWorkGroupHeader')[0].props.group.turnUserMessageId).toBeNull();
    });

    it.each(['ios', 'web'])('pages automatically near the oldest row, one page at a time, until the turn completes on %s', async (platform) => {
        state.platform = platform;
        const renderer = open();
        const page = pendingPage();
        layout(renderer);
        scroll(renderer, 10); scroll(renderer, 20);
        expect(page.started()).toBe(1);
        renderChat(renderer);
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
        await settle(renderer, history(700), true, page.finish);
        // The page rendered into the same group, and the reader is still at the top.
        expect(messageIds(renderer)).toEqual(['m800', 'm799', 'm798']);
        expect(headerIds(renderer)).toEqual(['work-m798']);
        expect(page.started()).toBe(2);
        await settle(renderer, history(800), false, page.finish);
        expect(messageIds(renderer)).toEqual(['m800', 'm799', 'm798', 'm3', 'm2', 'm1']);
        expect(headerIds(renderer)).toEqual(['work-m798']);
        expect(renderer.root.findAllByType('AgentWorkGroupHeader')[0].props.group.turnUserMessageId).toBe('m3');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        scroll(renderer, 30);
        expect(page.started()).toBe(2);
    });

    it('keeps paging through a turn whose work spans more pages than the invisible-page budget', async () => {
        const renderer = open(longTurn(600));
        const page = pendingPage();
        layout(renderer);
        expect(page.started()).toBe(1);
        // Every page lands inside the same collapsed turn. The oldest row is
        // still that turn's group, but the group now reaches further back —
        // progress toward the turn's opener, not a page with nothing in it.
        for (let count = 700; count <= 1200; count += 100) {
            await settle(renderer, longTurn(count), true, page.finish);
        }
        expect(page.started()).toBe(7);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
        await settle(renderer, longTurn(1300), false, page.finish);
        expect(messageIds(renderer)).toEqual(['t1300', 't1299', 't1298', 't1']);
        expect(headerIds(renderer)).toEqual(['work-t1298']);
        expect(page.started()).toBe(7);
    });

    it('keeps a group the reader expanded open while its older members and opener arrive', async () => {
        const renderer = open();
        const page = pendingPage();
        act(() => renderer.root.findAllByType('AgentWorkGroupHeader')[0].props.onToggle());
        expect(messageIds(renderer)).toContain('m201');
        layout(renderer);
        await settle(renderer, history(800), false, page.finish);
        expect(headerIds(renderer)).toEqual(['work-m798', 'work-m798']);
        expect(messageIds(renderer)).toContain('m4');
        expect(messageIds(renderer)).toContain('m3');
    });

    it('does not load while the reader is away from the oldest rendered row', () => {
        const renderer = open();
        const page = pendingPage();
        layout(renderer, { content: 3000 });
        scroll(renderer, 1000, 3000);
        expect(page.started()).toBe(0);
        scroll(renderer, 2000, 3000);
        expect(page.started()).toBe(1);
    });

    it('expands fully cached history with no network', () => {
        const renderer = open(history(800), false);
        expect(messageIds(renderer)).toEqual(['m800', 'm799', 'm798', 'm3']);
        layout(renderer);
        expect(messageIds(renderer)).toEqual(['m800', 'm799', 'm798', 'm3', 'm2', 'm1']);
        expect(sync.loadOlderMessages).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
    });

    it('chains through non-rendering pages on the store flag alone, until something renders or history ends', async () => {
        const renderer = open(thinking(600));
        expect(renderer.root.findByType('FlashList').props.data).toHaveLength(0);
        const page = pendingPage();
        layout(renderer, { content: 40 });
        expect(page.started()).toBe(1);
        // Nothing renders, so no scroll or content-size event will ever arrive.
        await settle(renderer, thinking(700), true, page.finish);
        expect(page.started()).toBe(2);
        await settle(renderer, [...thinking(800), userMessage('old-user', 1)], false, page.finish);
        expect(messageIds(renderer)).toContain('old-user');
        expect(page.started()).toBe(2);
    });

    it('pauses after five invisible pages until the reader explicitly loads more', async () => {
        const renderer = open(thinking(600));
        const page = pendingPage();
        layout(renderer, { content: 40 });
        expect(page.started()).toBe(1);
        for (let index = 1; index <= 5; index++) {
            await settle(renderer, thinking(600 + index * 100), true, page.finish);
        }
        expect(page.started()).toBe(5);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
        scroll(renderer, 10); scroll(renderer, 20);
        expect(page.started()).toBe(5);
        state.messages = [...thinking(1100), userMessage('background-visible', 1)];
        state.hasMoreOlder = true;
        renderChat(renderer);
        expect(page.started()).toBe(5);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
        act(() => renderer.root.findByType('RoundButton').props.onPress());
        expect(page.started()).toBe(6);
    });

    it('stops when sync reports history exhausted, even with nothing rendered', async () => {
        const renderer = open(thinking(600));
        const page = pendingPage();
        layout(renderer, { content: 40 });
        await settle(renderer, thinking(700), false, page.finish);
        expect(page.started()).toBe(1);
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
    });

    it('does not reset the invisible-page budget when new live rows arrive', async () => {
        const live = [userMessage('oldest-visible', 900)];
        const renderer = open([...live, ...thinking(600)]);
        state.session = { ...state.session, thinking: true };
        renderChat(renderer);
        const page = pendingPage();
        layout(renderer, { content: 40 });
        for (let index = 1; index <= 5; index++) {
            live.unshift(agentMessage(`live-${index}`, 900 + index));
            await settle(renderer, [...live, ...thinking(600 + index * 100)], true, page.finish);
        }
        expect(messageIds(renderer)).toHaveLength(6);
        expect(page.started()).toBe(5);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
    });

    it('does not reset the invisible-page budget when the oldest group expands', async () => {
        const visible = [agentMessage('final', 1000), toolMessage('tool', 999)];
        const renderer = open([...visible, ...thinking(600)]);
        const page = pendingPage();
        layout(renderer, { content: 40 });
        for (let index = 1; index <= 5; index++) {
            if (index === 5) {
                act(() => renderer.root.findByType('AgentWorkGroupHeader').props.onToggle());
                expect(messageIds(renderer)).toContain('tool');
            }
            await settle(renderer, [...visible, ...thinking(600 + index * 100)], true, page.finish);
        }
        expect(page.started()).toBe(5);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
    });

    it('resets the budget when the oldest boundary advances even if the row count stays equal', async () => {
        const visible = [userMessage('newer', 901), userMessage('oldest', 900)];
        const renderer = open([...visible, ...thinking(600)]);
        const page = pendingPage();
        layout(renderer, { content: 40 });
        for (let index = 1; index <= 4; index++) {
            await settle(renderer, [...visible, ...thinking(600 + index * 100)], true, page.finish);
        }
        // One newer row disappears while an older visible row arrives: total
        // row count is unchanged, but the reader has made progress into history.
        const progressed = [visible[1], ...thinking(1100), userMessage('older', -1000)];
        await settle(renderer, progressed, true, page.finish);
        expect(messageIds(renderer)).toEqual(['oldest', 'older']);
        expect(page.started()).toBe(6);
        for (let index = 1; index <= 5; index++) {
            await settle(renderer, [...progressed, ...thinking(index * 100, -1001)], true, page.finish);
        }
        expect(page.started()).toBe(10);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
    });

    it('rests, rather than spins, when a page resolves without moving the cursor while the store still advertises more', async () => {
        const renderer = open(thinking(600));
        const page = pendingPage();
        layout(renderer, { content: 40 });
        expect(page.started()).toBe(1);
        // The flag drops and re-renders, then the page resolves as a no-op.
        state.isLoadingOlder = false; renderChat(renderer);
        await act(async () => page.finish(0, false));
        await act(async () => { await Promise.resolve(); });
        expect(page.started()).toBe(1);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
        // A later store change (a background page landing) resumes it.
        await settle(renderer, thinking(700), true, () => {});
        expect(page.started()).toBe(2);
    });

    it('rests in the empty placeholder when a page resolves without progress', async () => {
        state.messages = [];
        state.hasMoreOlder = true;
        const session: any = { id: 'empty', createdAt: 1, metadata: null };
        const page = pendingPage();
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(React.createElement(EmptyMessages, { session })); });
        renderers.push(renderer);
        state.isLoadingOlder = false;
        act(() => renderer.update(React.createElement(EmptyMessages, { session })));
        await act(async () => page.finish(0, false));
        await act(async () => { await Promise.resolve(); });
        expect(page.started()).toBe(1);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
    });

    it('stops after a failed page until the reader retries', async () => {
        const renderer = open();
        const page = pendingPage();
        layout(renderer);
        renderChat(renderer); // the store renders the raised flag
        // Sync's finally drops the store flag (and the store renders) before
        // the caller sees the rejection.
        state.isLoadingOlder = false;
        renderChat(renderer);
        expect(page.started()).toBe(1);
        await act(async () => page.fail(new Error('503'), 0));
        expect(page.started()).toBe(1);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.retry');
        scroll(renderer, 10); scroll(renderer, 20);
        expect(page.started()).toBe(1);
        act(() => renderer.root.findByType('RoundButton').props.onPress());
        expect(page.started()).toBe(2);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
        await settle(renderer, history(800), false, page.finish);
        expect(messageIds(renderer)).toContain('m1');
    });

    it('waits for a background page instead of duplicating it, then continues', async () => {
        const renderer = open();
        state.isLoadingOlder = true; renderChat(renderer);
        layout(renderer);
        expect(sync.loadOlderMessages).not.toHaveBeenCalled();
        const page = pendingPage();
        await settle(renderer, history(700), true, () => { state.isLoadingOlder = false; });
        expect(page.started()).toBe(1);
    });

    it('blocks a web scroll after rejection but before the error state commits', async () => {
        state.platform = 'web';
        const renderer = open();
        const page = pendingPage();
        layout(renderer);
        renderChat(renderer);
        state.isLoadingOlder = false;
        renderChat(renderer);
        await act(async () => {
            page.fail(new Error('503'));
            // Run the promise handler, but leave its React update queued until
            // this act finishes. A web scroll may run in precisely this gap.
            await Promise.resolve();
            expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
            renderer.root.findByType('FlashList').props.onScroll({ nativeEvent: {
                contentOffset: { y: 10 }, contentSize: { height: 600 }, layoutMeasurement: { height: 600 },
            } });
            expect(page.started()).toBe(1);
        });
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.retry');
        act(() => renderer.root.findByType('RoundButton').props.onPress());
        expect(page.started()).toBe(2);
    });

    it('ignores a page settling for a previous session or after unmount', async () => {
        const renderer = open();
        const page = pendingPage();
        layout(renderer);
        expect(sync.loadOlderMessages).toHaveBeenLastCalledWith('session');
        // The store's flag is per session; the new session starts clear.
        state.isLoadingOlder = false;
        state.session = { ...state.session, id: 'other' }; renderChat(renderer);
        layout(renderer);
        expect(sync.loadOlderMessages).toHaveBeenLastCalledWith('other');
        expect(page.started()).toBe(2);
        await act(async () => page.fail(new Error('old session'), 0));
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
        act(() => renderer.unmount());
        await act(async () => page.finish(1));
        expect(page.started()).toBe(2);
    });

    it('does not act on a stale window once the messages empty out', () => {
        const renderer = open();
        const page = pendingPage();
        layout(renderer);
        expect(page.started()).toBe(1);
        state.isLoadingOlder = false;
        state.messages = []; renderChat(renderer);
        scroll(renderer, 10);
        expect(page.started()).toBe(1);
    });

    it('pages the truly empty placeholder automatically and offers retry on failure', async () => {
        state.messages = [];
        state.hasMoreOlder = true;
        const session: any = { id: 'empty', createdAt: 1, metadata: null };
        const page = pendingPage();
        let renderer!: ReturnType<typeof create>;
        const render = () => act(() => renderer.update(React.createElement(EmptyMessages, { session })));
        act(() => { renderer = create(React.createElement(EmptyMessages, { session })); });
        renderers.push(renderer);
        expect(page.started()).toBe(1);
        // Sync's real order: flag raised and rendered; flag dropped and
        // rendered; only then does the rejection reach this component.
        render();
        state.isLoadingOlder = false;
        render();
        expect(page.started()).toBe(1);
        await act(async () => page.fail(new Error('503'), 0));
        expect(page.started()).toBe(1);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.retry');
        act(() => renderer.root.findByType('RoundButton').props.onPress());
        expect(page.started()).toBe(2);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
        render();
        state.hasMoreOlder = false;
        await act(async () => page.finish());
        render();
        expect(page.started()).toBe(2);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'No messages yet')).toBe(true);
    });

    it('pauses the empty placeholder after five invisible pages until load more', async () => {
        state.messages = [];
        state.hasMoreOlder = true;
        const session: any = { id: 'empty', createdAt: 1, metadata: null };
        const page = pendingPage();
        let renderer!: ReturnType<typeof create>;
        const render = () => renderer.update(React.createElement(EmptyMessages, { session }));
        act(() => { renderer = create(React.createElement(EmptyMessages, { session })); });
        renderers.push(renderer);
        expect(page.started()).toBe(1);
        for (let index = 1; index <= 5; index++) {
            await act(async () => {
                state.messages = [];
                state.hasMoreOlder = true;
                state.isLoadingOlder = false;
                render();
                page.finish();
                render();
            });
        }
        expect(page.started()).toBe(5);
        expect(renderer.root.findByType('RoundButton').props.title).toBe('common.loadMore');
        act(() => renderer.root.findByType('RoundButton').props.onPress());
        expect(page.started()).toBe(6);
        expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
    });

    it('stops the empty placeholder when its parent replaces it before the page settles', async () => {
        state.messages = [];
        state.hasMoreOlder = true;
        const session: any = { id: 'empty', createdAt: 1, metadata: null };
        // SessionView mounts the placeholder only while the store is empty.
        const Parent = () => state.messages.length === 0
            ? React.createElement(EmptyMessages, { session })
            : React.createElement('MessagesArrived');
        const page = pendingPage();
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(React.createElement(Parent)); });
        renderers.push(renderer);
        for (let index = 1; index <= 4; index++) {
            await act(async () => {
                page.finish();
                renderer.update(React.createElement(Parent));
            });
        }
        expect(page.started()).toBe(5);
        state.messages = [userMessage('recovered', 1)];
        act(() => renderer.update(React.createElement(Parent)));
        await act(async () => page.finish());
        expect(renderer.root.findAllByType(EmptyMessages)).toHaveLength(0);
        expect(renderer.root.findAllByType('MessagesArrived')).toHaveLength(1);
        expect(page.started()).toBe(5);
    });
});

describe('ChatList web wheel listener lifecycle', () => {
    function scrollNode() {
        return { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    }

    it('does not attach a wheel listener on native', () => {
        state.scrollNode = scrollNode();
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        renderChat(undefined);
        expect(state.scrollNode.addEventListener).not.toHaveBeenCalled();
    });

    it('rebinds on a session list remount and removes the current listener on unmount', () => {
        state.platform = 'web';
        const first = scrollNode();
        state.scrollNode = first;
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        const renderer = renderChat(undefined);
        expect(first.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });

        const second = scrollNode();
        state.scrollNode = second;
        state.session = { ...state.session, id: 'other-session' };
        renderChat(renderer);
        expect(first.removeEventListener).toHaveBeenCalledWith('wheel', first.addEventListener.mock.calls[0][1]);
        expect(second.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
        act(() => renderer.unmount());
        expect(second.removeEventListener).toHaveBeenCalledWith('wheel', second.addEventListener.mock.calls[0][1]);
    });
});

describe('ChatList work-group folding', () => {
    it.each(['accepted', 'rejected'])('keeps the watched turn expanded when a pending prompt is %s', (outcome) => {
        const pending = { ...userMessage('pending', 6), pending: true };
        state.messages = [pending, ...completedTurnMessages()];
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };
        const renderer = renderChat(undefined);

        state.session = { ...state.session, thinking: false, metadata: { revision: 2 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');
        expect(renderer.root.findAllByType('AgentWorkGroupHeader')[0].props.group.turnUserMessageId).toBe('user');

        state.messages = [{ ...pending, pending: false, ...(outcome === 'rejected' ? { sendError: 'Not available.' } : {}) }, ...completedTurnMessages()];
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');
    });

    it.each([{ pending: true }, { sendError: 'Not available.' }])('does not trim the running turn at an unaccepted prompt while older history loads (%j)', (status) => {
        state.messages = [
            { ...userMessage('pending', 6), ...status },
            agentMessage('streaming', 5),
            toolMessage('tool', 4),
        ];
        state.hasMoreOlder = true;
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };

        const renderer = renderChat(undefined);
        expect(messageIds(renderer)).toEqual(['pending', 'streaming', 'tool']);
    });

    it('keeps a turn expanded when it finishes while the reader is watching', () => {
        state.messages = completedTurnMessages();
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };
        const renderer = renderChat(undefined);

        expect(messageIds(renderer)).toContain('tool-earliest');

        state.session = { ...state.session, thinking: false, metadata: { revision: 2 } };
        renderChat(renderer);

        expect(messageIds(renderer)).toContain('tool-earliest');
        const liveHeader = renderer.root.findAllByType('AgentWorkGroupHeader')[0];
        act(() => liveHeader.props.onToggle());
        expect(messageIds(renderer)).not.toContain('tool-earliest');
    });

    it('keeps the live turn through an inactive foreground transition, but folds it in background', () => {
        state.messages = completedTurnMessages();
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };
        const renderer = renderChat(undefined);
        state.session = { ...state.session, thinking: false, metadata: { revision: 2 } };
        renderChat(renderer);

        act(() => state.appStateListeners[0]('inactive'));
        expect(messageIds(renderer)).toContain('tool-earliest');

        act(() => state.appStateListeners[0]('background'));
        expect(messageIds(renderer)).not.toContain('tool-earliest');

        act(() => state.appStateListeners[0]('active'));
        state.session = { ...state.session, thinking: true, metadata: { revision: 3 } };
        renderChat(renderer);
        state.session = { ...state.session, thinking: false, metadata: { revision: 4 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');

        act(() => {
            state.appStateListeners[0]('background');
            state.appStateListeners[0]('active');
        });
        expect(messageIds(renderer)).not.toContain('tool-earliest');
    });

    it('keeps completed turns collapsed when first opened, while explicit expansion still works', () => {
        state.messages = completedTurnMessages();
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        const renderer = renderChat(undefined);

        expect(messageIds(renderer)).not.toContain('tool-earliest');
        const collapsedHeader = renderer.root.findByType('AgentWorkGroupHeader');
        act(() => collapsedHeader.props.onToggle());
        expect(messageIds(renderer)).toContain('tool-earliest');

        const expandedHeaders = renderer.root.findAllByType('AgentWorkGroupHeader');
        act(() => expandedHeaders[expandedHeaders.length - 1].props.onToggle());
        expect(messageIds(renderer)).not.toContain('tool-earliest');
    });

    it('does not treat completed history hydrated after mount as a live turn', () => {
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        state.messages = [];
        const renderer = renderChat(undefined);

        state.messages = completedTurnMessages();
        state.session = { ...state.session, metadata: { revision: 2 } };
        renderChat(renderer);

        expect(messageIds(renderer)).not.toContain('tool-earliest');
    });

    it('keeps a watched turn expanded across remote and local prompts', () => {
        state.messages = completedTurnMessages();
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };
        const renderer = renderChat(undefined);

        state.session = { ...state.session, thinking: false, metadata: { revision: 2 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');

        const remotePrompt = userMessage('remote-user', 10, 'remote-mobile-local-id');
        state.messages = [
            agentMessage('remote-final', 14),
            toolMessage('remote-tool', 13),
            remotePrompt,
            ...completedTurnMessages(),
        ];
        state.session = { ...state.session, thinking: true, metadata: { revision: 3 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');

        state.messages = [
            agentMessage('local-final', 18),
            toolMessage('local-tool', 17),
            userMessage('local-user', 16, 'this-device-local-id'),
            ...state.messages,
        ];
        state.session = { ...state.session, thinking: false, metadata: { revision: 4 } };
        renderChat(renderer);

        expect(messageIds(renderer)).toContain('tool-earliest');
        expect(messageIds(renderer)).toContain('remote-tool');
        expect(messageIds(renderer)).not.toContain('local-tool');
    });

    it('preserves an explicitly expanded historic turn when another device sends a prompt', () => {
        state.messages = twoCompletedTurns();
        state.session = { id: 'session', metadata: null, thinking: false, agentState: { requests: {} } };
        const renderer = renderChat(undefined);

        const historicHeader = renderer.root.findAllByType('AgentWorkGroupHeader')
            .find((node: any) => node.props.group.turnUserMessageId === 'user-old');
        expect(historicHeader).toBeDefined();
        act(() => historicHeader!.props.onToggle());
        expect(messageIds(renderer)).toContain('tool-old');

        state.messages = [userMessage('external-user', 10, 'remote-mobile-local-id'), ...state.messages];
        renderChat(renderer);

        expect(messageIds(renderer)).toContain('tool-old');
    });

    it('clears watched expansion when navigating away or switching sessions', () => {
        state.messages = completedTurnMessages();
        state.session = { id: 'session', metadata: null, thinking: true, agentState: { requests: {} } };
        const renderer = renderChat(undefined);
        state.session = { ...state.session, thinking: false, metadata: { revision: 2 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');

        renderChat(renderer, false);
        expect(messageIds(renderer)).not.toContain('tool-earliest');
        renderChat(renderer, true);
        expect(messageIds(renderer)).not.toContain('tool-earliest');

        state.session = { ...state.session, thinking: true, metadata: { revision: 3 } };
        renderChat(renderer);
        state.session = { ...state.session, thinking: false, metadata: { revision: 4 } };
        renderChat(renderer);
        expect(messageIds(renderer)).toContain('tool-earliest');

        state.session = { ...state.session, id: 'other-session', metadata: { revision: 5 } };
        renderChat(renderer);
        expect(messageIds(renderer)).not.toContain('tool-earliest');
    });
});