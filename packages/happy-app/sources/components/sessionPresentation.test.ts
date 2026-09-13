import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { Message, ToolCall } from '@/sync/typesMessage';

const state = vi.hoisted(() => ({
    platform: 'ios',
    tablet: false,
    session: null as Session | null,
    message: null as Message | null,
    messagesLoaded: false,
    params: { id: 'session-id' } as Record<string, string>,
    push: vi.fn(),
    back: vi.fn(),
    sessionVisible: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: {
            get OS() { return state.platform; },
            select: (values: any) => values[state.platform] ?? values.default,
        },
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
        ActivityIndicator: host('ActivityIndicator'), TouchableOpacity: host('TouchableOpacity'), Image: host('Image'),
        Animated: {
            Value: class { constructor(public value: number) {} },
            timing: () => ({ start: (callback?: (result: { finished: boolean }) => void) => callback?.({ finished: true }) }),
            View: host('AnimatedView'),
        },
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 52, useIsTablet: () => state.tablet }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800, headerMaxWidth: 800 } }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            text: 'text', textSecondary: 'secondary', surface: 'surface', divider: 'divider',
            gitAddedText: 'green', gitRemovedText: 'red',
            header: { tint: 'tint', background: 'background' },
            glass: { border: 'border', backgroundStrong: 'glass', shadow: 'shadow' },
            groupped: { background: 'background', chevron: 'chevron' },
            shadow: { color: 'shadow', opacity: 1, offset: { width: 0, height: 1 }, radius: 2 },
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (factory: any) => typeof factory === 'function' ? factory(theme, { insets: { top: 0 } }) : factory, hairlineWidth: 1 },
    };
});
vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    const Icon = (props: any) => ReactModule.createElement('Icon', props);
    return { Ionicons: Icon, Octicons: Icon };
});
vi.mock('@/components/MobileGlass', async () => {
    const ReactModule = await import('react');
    return {
        MobileGlassSurface: (props: any) => ReactModule.createElement('Glass', props, props.children),
        MobileGlassBackdrop: () => null,
    };
});
vi.mock('@/components/BubblePressable', async () => {
    const ReactModule = await import('react');
    return { BubblePressable: (props: any) => ReactModule.createElement('BubblePressable', props, props.children) };
});
vi.mock('@/components/navigation/MobileHeaderScrim', () => ({
    MobileHeaderScrim: () => null,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY: 1,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY: 0,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY: 1,
}));
vi.mock('expo-router', async () => {
    const ReactModule = await import('react');
    return {
        Stack: Object.assign((props: any) => ReactModule.createElement('Stack', props, props.children), {
            Screen: (props: any) => ReactModule.createElement('StackScreen', props),
        }),
        useRouter: () => ({ push: state.push, back: state.back }),
        useLocalSearchParams: () => state.params,
    };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => state.session,
    useMessage: () => state.message,
    useSessionMessages: () => ({ isLoaded: state.messagesLoaded }),
    useIsDataReady: () => true,
    useSessionGitStatus: () => null,
    useSessionGitStatusFiles: () => null,
}));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: state.sessionVisible } }));
vi.mock('@/components/Deferred', async () => {
    const ReactModule = await import('react');
    return { Deferred: (props: any) => ReactModule.createElement('Deferred', props, props.children) };
});
vi.mock('@/components/tools/ToolFullView', async () => {
    const ReactModule = await import('react');
    return { ToolFullView: (props: any) => ReactModule.createElement('ToolFullView', props) };
});
vi.mock('@/utils/sessionUtils', () => ({
    getSessionName: () => 'A long session title that needs the available header width',
    useSessionStatus: () => ({ isConnected: true, isPulsing: true, statusText: 'Working' }),
    formatOSPlatform: () => '', formatPathRelativeToHome: (path: string) => path,
    getResumeCommand: () => null,
}));
vi.mock('@/text', () => ({ t: (key: string, params?: { count: number }) => params ? `${params.count} changed files` : key }));
vi.mock('@/components/Item', async () => {
    const ReactModule = await import('react');
    return { Item: (props: any) => ReactModule.createElement('Item', props, props.rightElement) };
});
vi.mock('@/components/ItemGroup', async () => {
    const ReactModule = await import('react');
    return { ItemGroup: (props: any) => ReactModule.createElement('ItemGroup', props, props.children) };
});
vi.mock('@/components/ItemList', async () => {
    const ReactModule = await import('react');
    return { ItemList: (props: any) => ReactModule.createElement('ItemList', props, props.children) };
});
vi.mock('@/components/CodeView', () => ({ CodeView: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ sessionArchive: vi.fn(), sessionKill: vi.fn(), sessionDelete: vi.fn() }));
vi.mock('@/hooks/useWorktreeCleanup', () => ({ maybeCleanupWorktree: vi.fn() }));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: unknown) => [false, action] }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({}) }));
vi.mock('@/utils/copySessionMetadataToClipboard', () => ({
    copySessionMetadataToClipboard: vi.fn(), copySessionMetadataAndLogsToClipboard: vi.fn(),
}));
vi.mock('@/utils/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '1' }));

import { ChatHeaderView } from './ChatHeaderView';
import { Header, createPlainHeader } from './navigation/Header';
import { GitLineChanges } from './GitLineChanges';
import { RigGitLineChanges } from './RigGitLineChanges';
import SessionInfo from '@/app/(app)/session/[id]/info';
import MessageDetails from '@/app/(app)/session/[id]/message/[messageId]';
import RootLayout from '@/app/(app)/_layout';

const renderers: ReturnType<typeof create>[] = [];
const originalConsoleError = console.error;
beforeAll(() => {
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});
afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    state.platform = 'ios';
    state.tablet = false;
    state.message = null;
    state.messagesLoaded = false;
    state.params = { id: 'session-id' };
    state.push.mockClear();
    state.back.mockClear();
    state.sessionVisible.mockClear();
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function render(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(element); });
    renderers.push(renderer!);
    return renderer!;
}
function texts(renderer: ReturnType<typeof create>): string[] {
    return renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));
}

describe('chat header', () => {
    it.each(['ios', 'android', 'web'])('shows workspace and counts on the second line on %s', (platform) => {
        state.platform = platform;
        const renderer = render(React.createElement(ChatHeaderView, {
            title: 'Session title', subtitle: 'nice',
            gitChanges: { insertions: 120, deletions: 34, approximate: false },
        }));
        expect(texts(renderer)).toEqual(['Session title', 'nice', '+120', '-34']);
    });

    it('keeps the subtitle even if it matches the session title', () => {
        expect(texts(render(React.createElement(ChatHeaderView, { title: 'nice', subtitle: 'nice' })))).toEqual(['nice', 'nice']);
    });

    it('omits unavailable git information and keeps file overlays visible', () => {
        expect(texts(render(React.createElement(ChatHeaderView, { title: 'Session' })))).toEqual(['Session']);
        expect(texts(render(React.createElement(ChatHeaderView, {
            title: 'Session', subtitle: 'nice', extraPathSegment: 'src/app.ts',
        })))).toEqual(['Session', 'nice', '•', 'src/app.ts']);
    });

    it('removes stale counts when the workspace becomes clean', () => {
        const renderer = render(React.createElement(ChatHeaderView, {
            title: 'Session', subtitle: 'nice',
            gitChanges: { insertions: 120, deletions: 0, approximate: true },
        }));
        expect(texts(renderer)).toEqual(['Session', 'nice', '≈', '+120']);
        act(() => renderer.update(React.createElement(ChatHeaderView, {
            title: 'Session', subtitle: 'nice', gitChanges: null,
        })));
        expect(texts(renderer)).toEqual(['Session', 'nice']);
    });
});

describe('session details', () => {
    it('puts Changes and Happy Agent stats first, without the duplicate title/status card', () => {
        state.session = {
            id: 'session-id', createdAt: 1, updatedAt: 1, seq: 1,
            metadata: {
                path: '/repo', host: 'machine',
                client: { id: 'rig', name: 'Happy Agent', version: '1' },
                git: { changedFiles: 5, insertions: 120, deletions: 34, countsExact: true },
            },
        } as Session;
        const renderer = render(React.createElement(SessionInfo));
        const groups = renderer.root.findAllByType('ItemGroup');
        expect(groups[0].props.title).toBe('sessionInfo.quickActions');
        const items = renderer.root.findAllByType('Item');
        expect(items[0].props.title).toBe('files.changes');
        expect(items[0].props.subtitle).toBeUndefined();
        expect(texts(renderer)).toEqual(['5 changed files', '+120', '-34']);
        expect(items.some((item: any) => item.props.title === 'sessionInfo.connectionStatus')).toBe(true);
        expect(renderer.root.findAllByType('Glass')).toHaveLength(0);
        expect(renderer.root.findByType('StackScreen').props.options.headerTitleAlign).toBe('center');
        expectCountTypography(renderer);
        act(() => items[0].props.onPress());
        expect(state.push).toHaveBeenCalledWith('/session/session-id/changes');
    });

    it('honors left alignment so the title uses space after the back button', () => {
        const renderer = render(createPlainHeader({
            options: { headerTitle: 'Long session title', headerTitleAlign: 'left' },
            route: { name: 'session/[id]/info' }, back: { title: 'Chat' },
            navigation: { goBack: vi.fn() },
        } as any)!);
        const header = renderer.root.findByType((Header as any).type);
        expect(header.props.mobileTitleAlignment).toBe('start');
        expect(header.props.headerRight).toBeUndefined();
        expect(texts(renderer)).toEqual(['Long session title']);
    });

    it.each(['ios', 'android', 'web', 'ipad'])('centers the detail title between symmetric insets on %s', (platform) => {
        state.platform = platform === 'ipad' ? 'ios' : platform;
        state.tablet = platform === 'ipad';
        const renderer = render(createPlainHeader({
            options: { headerTitle: 'Long session title', headerTitleAlign: 'center' },
            route: { name: 'session/[id]/info' }, back: { title: 'Chat' },
            navigation: { goBack: vi.fn() },
        } as any)!);
        const header = renderer.root.findByType((Header as any).type);
        expect(header.props.mobileTitleAlignment).toBe('center');
        expect(header.props.titleAlignment).toBe('center');
        const centered = renderer.root.findAllByType('View').map((node: any) => flattenStyle(node.props.style))
            .find((style: any) => style.position === 'absolute' && style.alignItems === 'center');
        expect(centered.left).toBe(centered.right);
        const title = renderer.root.findByType('Text');
        expect(flattenStyle(title.props.style).textAlign).toBe('center');
        expect(title.props.numberOfLines).toBe(1);
    });

    it('keeps Changes available for a legacy session without cached statistics', () => {
        state.session = {
            id: 'session-id', createdAt: 1, updatedAt: 1, seq: 1,
            metadata: { path: '/repo', host: 'machine' },
        } as Session;
        const renderer = render(React.createElement(SessionInfo));
        const firstItem = renderer.root.findAllByType('Item')[0];
        expect(firstItem.props.title).toBe('files.changes');
        expect(firstItem.props.rightElement).toBeUndefined();
        expect(firstItem.props.disabled).not.toBe(true);
        act(() => firstItem.props.onPress());
        expect(state.push).toHaveBeenCalledWith('/session/session-id/changes');
    });
});

function flattenStyle(style: any): Record<string, unknown> {
    return Array.isArray(style) ? Object.assign({}, ...style.map(flattenStyle)) : style || {};
}

function expectCountTypography(renderer: ReturnType<typeof create>) {
    const counts = renderer.root.findAllByType('Text').filter((node: any) => /^[+\-]\d/.test(node.children.join('')));
    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts) {
        expect(flattenStyle(count.props.style)).toMatchObject({
            fontFamily: 'IBMPlexSans-Regular', fontSize: 11, fontWeight: '600',
        });
    }
}

describe('shared git-count typography', () => {
    const changes = { approximate: false, insertions: 120, deletions: 34 };

    it('uses the grouped project font in the shared counts and flat-list adapter', () => {
        expectCountTypography(render(React.createElement(GitLineChanges, { changes })));
        expectCountTypography(render(React.createElement(RigGitLineChanges, {
            changedFiles: 2, countsExact: true, insertions: 120, deletions: 34,
        })));
    });

    it('keeps the same font in the chat subtitle', () => {
        expectCountTypography(render(React.createElement(ChatHeaderView, {
            title: 'Session', subtitle: 'main', gitChanges: changes,
        })));
    });
});

describe('tool-detail navigation', () => {
    // The storage mock is not a subscription. Exercise the memo's render
    // function so updates model the real hooks notifying their consumer.
    const MessageDetailContent = (MessageDetails as any).type;
    function message(tool: Partial<ToolCall> = {}): Message {
        return {
            id: 'tool-message', kind: 'tool-call', createdAt: 1, localId: null, children: [],
            tool: { name: 'apply_patch', input: {}, description: null, createdAt: 1, state: 'running', ...tool },
        } as Message;
    }

    function rootOptions() {
        const root = render(React.createElement(RootLayout));
        return root.root.findAllByType('StackScreen')
            .find((node: any) => node.props.name === 'session/[id]/message/[messageId]').props.options;
    }

    function navElement(options: any) {
        return options.header({
            options, route: { name: 'session/[id]/message/[messageId]' },
            back: { title: 'Session' }, navigation: { goBack: state.back },
        });
    }

    it('chooses a plain, non-interactive title in the root route before hydration', () => {
        expect(rootOptions()).toMatchObject({ header: createPlainHeader, headerTitleAlign: 'center', headerShown: true });
    });

    it('keeps the same header geometry through loading, tool updates and text messages', () => {
        state.session = null;
        state.params = { id: 'session-id', messageId: 'tool-message' };
        const defaults = rootOptions();
        const screen = render(React.createElement(MessageDetailContent));
        const currentOptions = () => ({ ...defaults, ...screen.root.findByType('StackScreen').props.options });
        const nav = render(navElement(currentOptions()));
        const originalHeader = nav.root.findByType((Header as any).type);
        const geometry = () => nav.root.findAllByType('View').map((node: any) => flattenStyle(node.props.style))
            .filter((style: any) => style.height === 52 || style.position === 'absolute');
        const originalGeometry = geometry();

        expect(screen.root.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(nav.root.findAllByType('Glass')).toHaveLength(1); // Only Back is a glass control, never the title.
        expect(originalHeader.props.mobileTitleSurface).toBe('plain');
        expect(nav.root.findAllByType('Pressable')).toHaveLength(1);
        expect(texts(nav)).toEqual(['common.message']);
        expect(state.sessionVisible).toHaveBeenCalledWith('session-id');

        for (const toolState of ['running', 'completed', 'error'] as const) {
            state.session = { id: 'session-id', metadata: { path: '/repo', host: 'machine' } } as Session;
            state.messagesLoaded = true;
            state.message = message({ state: toolState, title: 'A very long tool title '.repeat(20) });
            act(() => screen.update(React.createElement(MessageDetailContent)));
            act(() => nav.update(navElement(currentOptions())));

            expect(nav.root.findByType((Header as any).type)).toBe(originalHeader);
            expect(geometry()).toEqual(originalGeometry);
            expect(nav.root.findAllByType('Glass')).toHaveLength(1);
            expect(nav.root.findAllByType('Pressable')).toHaveLength(1);
            expect(currentOptions().headerRight).toBeUndefined();
            expect(texts(nav)).toHaveLength(1);
            expect(nav.root.findByType('Text').props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle' });
            expect(nav.root.findByType('Text').props.onPress).toBeUndefined();
            expect(screen.root.findByType('ToolFullView').props.metadata).toBe(state.session.metadata);
        }

        state.message = { id: 'text', kind: 'agent-text', text: 'Response', createdAt: 1, localId: null } as Message;
        act(() => screen.update(React.createElement(MessageDetailContent)));
        act(() => nav.update(navElement(currentOptions())));
        expect(texts(nav)).toEqual(['common.message']);
        expect(geometry()).toEqual(originalGeometry);
        expect(currentOptions().headerRight).toBeUndefined();
        act(() => nav.root.findByType('Pressable').props.onPress());
        expect(state.back).toHaveBeenCalledTimes(1);
    });

    it('keeps navigation available while a missing loaded message returns to the session', () => {
        state.messagesLoaded = true;
        state.message = null;
        const screen = render(React.createElement(MessageDetails));
        expect(screen.root.findAllByType('StackScreen')).toHaveLength(1);
        expect(screen.root.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(state.back).toHaveBeenCalledTimes(1);
    });
});