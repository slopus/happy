import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    appState: 'active' as 'active' | 'inactive' | 'background',
    appStateListeners: [] as Array<(next: 'active' | 'inactive' | 'background') => void>,
    messages: [] as any[],
    hasMoreOlder: false,
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
    return { Octicons: (props: any) => ReactModule.createElement('Octicons', props) };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => state.session,
    useSessionMessages: () => ({ messages: state.messages, hasMoreOlder: state.hasMoreOlder, isLoadingOlder: false }),
    useSetting: () => true,
}));
vi.mock('@/sync/storageTypes', () => ({}));
vi.mock('@/sync/typesMessage', () => ({}));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/utils/toolDisplay', () => ({ isInteractiveQuestionToolName: () => false }));
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn() } }));
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
        session: state.session,
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
    state.session = null;
    state.platform = 'ios';
    state.scrollNode = null;
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