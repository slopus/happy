import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const socketStatus = vi.hoisted(() => ({
    status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
    listeners: new Set<() => void>(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: { OS: 'ios' },
        Pressable: host('Pressable'),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('./navigation/Header', async () => {
    const ReactModule = await import('react');
    return { Header: (props: any) => ReactModule.createElement('Header', props, props.title) };
});

vi.mock('@/sync/storage', async () => {
    const ReactModule = await import('react');
    return {
        useFriendRequests: () => [],
        useRealtimeStatus: () => 'disconnected',
        useSettingMutable: () => ['flat', vi.fn()],
        useSocketStatus: () => ({ status: ReactModule.useSyncExternalStore(
            (listener) => { socketStatus.listeners.add(listener); return () => { socketStatus.listeners.delete(listener); }; },
            () => socketStatus.status,
        ) }),
    };
});

vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate: vi.fn(), push: vi.fn() }),
    useSegments: () => [],
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerInfo: () => ({ isCustom: true, hostname: '192.168.0.108', port: 3005 }),
    isUsingCustomServer: () => true,
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59 }) }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/useVisibleSessionListViewData', () => ({ useVisibleSessionListViewData: () => [] }));
vi.mock('@/hooks/useNewSessionDraft', () => ({ useNewSessionDraft: {} }));
vi.mock('@/hooks/useStartSessionFromDraft', () => ({ useStartSessionFromDraft: () => ({ isStarting: false }) }));
vi.mock('@/track', () => ({ trackFriendsSearch: vi.fn() }));
vi.mock('./NativeSettingsMenu', () => ({ NativeSettingsMenu: () => null }));
vi.mock('./EmptySessionsTablet', () => ({ EmptySessionsTablet: () => null }));
vi.mock('./SessionsList', () => ({ SessionsList: () => null }));
vi.mock('./TabBar', () => ({ TabBar: () => null }));
vi.mock('./InboxView', () => ({ InboxView: () => null }));
vi.mock('./SettingsViewWrapper', () => ({ SettingsViewWrapper: () => null }));
vi.mock('./HomeDock', () => ({ HomeDock: () => null, MOBILE_HOME_DOCK_CONTENT_INSET: 150 }));
vi.mock('./HeaderLogo', () => ({ HeaderLogo: () => null }));
vi.mock('./VoiceAssistantStatusBar', () => ({ VoiceAssistantStatusBar: () => null }));
vi.mock('./SessionsListWrapper', async () => {
    const ReactModule = await import('react');
    return { SessionsListWrapper: (props: any) => ReactModule.createElement('SessionsListWrapper', props) };
});

vi.mock('expo-image', async () => {
    const ReactModule = await import('react');
    return { Image: (props: any) => ReactModule.createElement('Image', props) };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function' ? factory({
            colors: {
                groupped: { background: 'background' },
                header: { tint: 'tint' },
                status: {
                    connected: 'connected',
                    connecting: 'connecting',
                    disconnected: 'disconnected',
                    error: 'error',
                    default: 'default',
                },
                surfaceSelected: 'selected',
                textSecondary: 'secondary',
            },
        }) : factory,
        hairlineWidth: 1,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: 'background' },
                header: { tint: 'tint' },
                status: { connected: 'connected', connecting: 'connecting', disconnected: 'disconnected', error: 'error' },
                textSecondary: 'secondary',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./ShortcutHints', () => ({
    ShortcutHintBadge: () => null,
    useShortcutHints: () => ({ visible: false }),
}));
vi.mock('./StatusDot', () => ({ StatusDot: () => null }));

import { HomeHeader, HomeHeaderNotAuth } from './HomeHeader';
import { HomeHeaderTitle } from './HomeHeaderTitle';
import { MainView } from './MainView';

const originalConsoleError = console.error;
const renderers: ReturnType<typeof create>[] = [];

function render(component: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(component); });
    renderers.push(renderer!);
    return renderer!;
}

function setSocketStatus(status: typeof socketStatus.status) {
    act(() => {
        socketStatus.status = status;
        for (const listener of socketStatus.listeners) listener();
    });
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());
afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    socketStatus.status = 'disconnected';
});

function renderHomeHeaderTitle(component: React.ReactElement) {
    const renderer = render(component);
    const header = renderer.root.findByType('Header' as any);
    expect(header.props.title.type).toBe(HomeHeaderTitle);
    return renderer;
}

describe('HomeHeaderNotAuth', () => {
    it('uses the standard plain mobile title instead of the glass title pill', () => {
        const header = render(React.createElement(HomeHeaderNotAuth)).root.findByType('Header' as any);
        expect(header.props.mobileTitleSurface).toBe('plain');
        expect(header.props.mobileTitleAlignment).toBe('center');
    });
});

describe('HomeHeader', () => {
    it('uses a centred, non-interactive plain title on mobile', () => {
        const header = render(React.createElement(HomeHeader)).root.findByType('Header' as any);
        expect(header.props.mobileTitleSurface).toBe('plain');
        expect(header.props.mobileTitleAlignment).toBe('center');
    });
});

describe('home header connection status', () => {
    it('keeps an empty subtitle slot when connected, without a fake status label', () => {
        socketStatus.status = 'connected';

        const title = renderHomeHeaderTitle(React.createElement(HomeHeader));

        const slot = title.root.findAllByType('View' as any).find((node: any) => node.props.testID === 'home-header-subtitle-slot');
        expect(slot.children).toHaveLength(0);
        expect(slot.props.style).toMatchObject({ position: 'absolute', top: '100%', minHeight: 16 });
        expect(title.root.findAllByType('Text' as any)).toHaveLength(1);
    });

    it.each(['connecting', 'disconnected', 'error'] as const)('shows the %s status line', (status) => {
        socketStatus.status = status;

        const title = renderHomeHeaderTitle(React.createElement(HomeHeader));

        expect(title.root.findAllByType('Text' as any)).toHaveLength(2);
        expect(title.root.findAllByType('Text' as any)[1].props.children).toBe(`status.${status}`);
    });

    it('preserves a custom subtitle when the socket is connected', () => {
        socketStatus.status = 'connected';

        const title = renderHomeHeaderTitle(React.createElement(HomeHeaderNotAuth));
        const texts = title.root.findAllByType('Text' as any);

        expect(texts).toHaveLength(2);
        expect(texts[1].props.children).toBe('192.168.0.108:3005');
    });

    it('keeps the centered title and its empty slot mounted across connection changes', () => {
        socketStatus.status = 'connected';
        const title = render(React.createElement(HomeHeaderTitle, { title: 'Sessions' }));
        const heading = title.root.findByProps({ accessibilityRole: 'header' });
        const slot = title.root.findByProps({ testID: 'home-header-subtitle-slot' });
        const anchor = heading.parent;
        const container = title.root.findAllByType('View' as any)[0];
        const layout = () => ({ container: container.props.style, anchor: anchor.props.style, heading: heading.props.style, slot: slot.props.style });
        const original = layout();
        expect(container.props).toMatchObject({
            pointerEvents: 'none', style: { flex: 1, alignSelf: 'stretch', justifyContent: 'center' },
        });
        expect(slot.props.style).toMatchObject({ position: 'absolute', top: '100%', left: 0, right: 0 });
        expect(heading.props.style.textAlign).toBe('center');

        for (const status of ['connecting', 'error', 'disconnected', 'connected'] as const) {
            setSocketStatus(status);
            expect(title.root.findByProps({ accessibilityRole: 'header' })).toBe(heading);
            expect(title.root.findByProps({ testID: 'home-header-subtitle-slot' })).toBe(slot);
            expect(layout()).toEqual(original);
            expect(title.root.findAllByType('Pressable' as any)).toHaveLength(0);
            expect(title.root.findAllByType('Text' as any)).toHaveLength(status === 'connected' ? 1 : 2);
        }
    });

    it('keeps a long custom subtitle in the same one-line slot and suppresses socket status', () => {
        const subtitle = 'a-very-long-custom-server-name.example.com:3005';
        const title = render(React.createElement(HomeHeaderTitle, { title: 'Sessions', subtitle }));
        for (const status of ['connecting', 'error', 'connected'] as const) {
            setSocketStatus(status);
            const texts = title.root.findAllByType('Text' as any);
            expect(texts).toHaveLength(2);
            expect(texts[1].props).toMatchObject({ children: subtitle, numberOfLines: 1, ellipsizeMode: 'middle' });
        }
    });

    it('uses the same stable title in the actual phone home without changing list insets', () => {
        socketStatus.status = 'connected';
        const home = renderHomeHeaderTitle(React.createElement(MainView, { variant: 'phone' }));
        const heading = home.root.findByProps({ accessibilityRole: 'header' });
        const list = home.root.findByType('SessionsListWrapper' as any);
        const insets = { ...list.props };
        const header = home.root.findByType('Header' as any);
        expect(header.props).toMatchObject({ mobileTitleSurface: 'plain', mobileTitleAlignment: 'center' });
        expect(heading.props.children).toBe('tabs.sessions');
        expect(insets).toMatchObject({ topContentInset: 123, scrollIndicatorTopInset: 111 });

        for (const status of ['connecting', 'error', 'disconnected', 'connected'] as const) {
            setSocketStatus(status);
            expect(home.root.findByProps({ accessibilityRole: 'header' })).toBe(heading);
            expect(home.root.findByType('SessionsListWrapper' as any).props).toEqual(insets);
            expect(home.root.findByType('Header' as any)).toBe(header);
        }
    });
});
