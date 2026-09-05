import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { SessionView } from './SessionView';

const mocks = vi.hoisted(() => ({
    abandonSessionRoute: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    fetchNextHistoryPage: vi.fn(),
    openSession: vi.fn(),
    session: null as any,
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Easing: { cubic: 'cubic', out: (value: unknown) => value },
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            accent: '#777', divider: '#444', groupped: { background: '#111' },
            header: { tint: '#fff' }, primary: '#777', shadow: { color: '#000', opacity: 0.2 },
            surface: '#171717', surfaceHigh: '#222', surfacePressed: '#333', text: '#fff',
            textSecondary: '#aaa', button: { primary: { background: '#777', tint: '#fff' } },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => {
                const styles = typeof factory === 'function'
                    ? (factory as (value: typeof theme) => object)(theme)
                    : factory;
                return { ...styles as object, useVariants: vi.fn() };
            },
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-application', () => ({ applicationId: 'build.paws.preview' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ dispatch: vi.fn() }),
    useRouter: () => ({ back: vi.fn(), navigate: vi.fn(), push: vi.fn() }),
}));
vi.mock('@react-navigation/native', () => ({ DrawerActions: { openDrawer: () => ({ type: 'OPEN' }) } }));

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ currentViewingSessionId: null, setCurrentViewingSession: vi.fn() }) },
    useIsDataReady: () => true,
    useLocalSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useLocalSettingMutable: () => [false, vi.fn()],
    useMachine: () => null,
    useSession: () => mocks.session,
    useSessionMessages: () => ({ messages: [], isLoaded: false }),
    useSessionUsage: () => undefined,
    useSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useSettingUpdater: () => vi.fn(),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        abandonSessionRoute: mocks.abandonSessionRoute,
        ensureSessionHydrated: mocks.ensureSessionHydrated,
        loadNextSessionHistoryPage: mocks.fetchNextHistoryPage,
        onSessionVisible: vi.fn(),
        openSession: mocks.openSession,
        sendMessage: vi.fn(),
        sessionRouteBecameInteractive: vi.fn(),
    },
}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: vi.fn() }));
vi.mock('@/sync/ops.screenshot', () => ({ requestScreenshot: vi.fn() }));
vi.mock('@/sync/screenshotGallery', () => ({
    addScreenshotEntry: vi.fn(), saveBase64Png: vi.fn(), useHasNewScreenshots: () => ({ hasNew: false }),
}));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), show: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({
    useDeviceType: () => 'phone', useHeaderHeight: () => 52, useIsLandscape: () => false, useIsTablet: () => false,
}));
vi.mock('@/utils/desktopNavigationLayout', () => ({
    DESKTOP_MAIN_MIN_WIDTH: 1100,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH: 0,
    TAURI_HEADER_CONTROL_LEFT: 0,
    getDesktopRightPanelPresentation: () => 'unavailable',
    getPersistentHeaderContentInset: () => 0,
    getPersistentNavigationControlsWidth: () => 0,
    getResponsiveRightPanelMode: () => 'drawer-toggle',
    shouldUseCompactSessionHeader: () => false,
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/utils/sessionUtils', () => ({
    formatPathRelativeToHome: (path: string) => path,
    getResumeCommandBlock: () => null,
    getSessionName: () => 'Session',
    useSessionStatus: () => ({
        isConnected: false, state: 'disconnected', statusColor: '#aaa', statusDotColor: '#aaa',
        statusText: 'Offline', isPulsing: false,
    }),
}));
vi.mock('@/utils/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '0.0.0' }));
vi.mock('@/utils/runningSessionTurnModes', () => ({ resolveRunningSessionTurnModes: () => ({}) }));
vi.mock('@/utils/codexFast', () => ({ supportsCodexFast: () => false }));
vi.mock('@/utils/sessionTitleTags', () => ({ findSessionTitleTagQuery: () => null, removeSessionTitleTagQuery: (v: string) => v }));
vi.mock('@/-session/sessionOverlayNav', () => ({ useOverlayNav: { getState: () => ({ publish: vi.fn(), reset: vi.fn() }) } }));

vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({
    useDesktopWorkspaceLayout: () => ({
        leftVisible: false, leftWidth: 0, rightPanelAvailable: false, rightExpandedWidth: 0, rightWidth: 0,
    }),
}));
vi.mock('@/hooks/useAgentSpace', () => ({ useAgentSpace: () => ({ enter: vi.fn(), exit: vi.fn() }), useSpaceAgentForSession: () => null }));
vi.mock('@/hooks/useGlobalKeyboard', () => ({ useGlobalKeyboard: vi.fn() }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({ renameSessionToTitle: vi.fn(), renamingSession: false }) }));
vi.mock('@/hooks/useSessionTaskPermission', () => ({ useSessionTaskPermission: () => ({}) }));
vi.mock('@/hooks/useSessionWorkingDirectory', () => ({ useSessionWorkingDirectory: () => ({}) }));
vi.mock('@/hooks/useDraft', () => ({ useDraft: () => ({ clearDraft: vi.fn() }) }));
vi.mock('@/hooks/useImagePicker', () => ({ useImagePicker: () => ({ selectedImages: [] }) }));

vi.mock('@/components/AgentContentView', () => ({ AgentContentView: 'AgentContentView' }));
vi.mock('@/components/MessageComposer', () => ({ MessageComposer: 'MessageComposer' }));
vi.mock('@/components/ChatHeaderView', () => ({ ChatHeaderView: 'ChatHeaderView' }));
vi.mock('@/components/SessionHeaderChip', () => ({ SessionHeaderChip: 'SessionHeaderChip' }));
vi.mock('@/components/SessionInfoDropdown', () => ({ SessionInfoDropdown: 'SessionInfoDropdown' }));
vi.mock('@/components/PublicSessionShareDialog', () => ({ PublicSessionShareDialog: 'PublicSessionShareDialog' }));
vi.mock('@/components/SessionOrganizerDialog', () => ({ SessionOrganizerDialog: 'SessionOrganizerDialog' }));
vi.mock('@/components/DesktopRightPanel', () => ({
    DesktopRightPanel: 'DesktopRightPanel',
    DesktopRightPanelToggleButton: 'DesktopRightPanelToggleButton',
}));
vi.mock('@/components/DesktopPresenceTransition', () => ({ DesktopPresenceTransition: 'DesktopPresenceTransition' }));
vi.mock('@/components/RightSwipePanelHost', () => ({ RightSwipePanelHost: 'RightSwipePanelHost' }));
vi.mock('@/components/ChatList', () => ({ ChatList: 'ChatList' }));
vi.mock('@/components/Deferred', () => ({ Deferred: 'Deferred' }));
vi.mock('@/components/EmptyMessages', () => ({ EmptyMessages: 'EmptyMessages' }));
vi.mock('@/components/FilesSidebar', () => ({ FilesSidebar: 'FilesSidebar' }));
vi.mock('@/components/AllFilesDiffView', () => ({ AllFilesDiffView: 'AllFilesDiffView' }));
vi.mock('@/components/FileViewPanel', () => ({ FileViewPanel: 'FileViewPanel' }));
vi.mock('@/components/agents/SessionAgentSpaceBoundary', () => ({
    AgentSpaceExitButton: 'AgentSpaceExitButton',
    SessionRightPanelContent: 'SessionRightPanelContent',
}));
vi.mock('@/components/subagent/SubagentInspectorPanel', () => ({ SubagentInspectorPanel: 'SubagentInspectorPanel' }));
vi.mock('@/components/layout', () => ({ layout: { headerMaxWidth: 800 } }));
vi.mock('@/components/autocomplete/suggestions', () => ({ getSuggestions: () => [] }));
vi.mock('@/components/ScreenshotGalleryDrawer', () => ({ ScreenshotGalleryDrawer: 'ScreenshotGalleryDrawer' }));
vi.mock('@/components/diff/PierreDiffView', () => ({ prefetchPierreDiff: vi.fn() }));
vi.mock('@/components/subagent/SubagentInspectorContext', async () => {
    const ReactModule = await import('react');
    return {
        SubagentInspectorProvider: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, {}, children),
        useSubagentInspector: () => null,
    };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

describe('SessionView deep-link hydration', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
        mocks.session = null;
        mocks.ensureSessionHydrated.mockResolvedValue(true);
        mocks.openSession.mockImplementation(async (id: string) => (
            await mocks.ensureSessionHydrated(id) ? 'ready' : 'not-found'
        ));
    });

    afterEach(() => {
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('bounds transient retries and exposes a deliberate retry action without preloaded messages', async () => {
        vi.useFakeTimers();
        mocks.openSession.mockRejectedValue(new Error('synthetic-network-failure'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="retry-session" />); });
        expect(renderer.root.findAllByProps({ testID: 'session-retrying' }).length).toBeGreaterThan(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(mocks.openSession.mock.calls.length).toBe(4);
        expect(renderer.root.findAllByProps({ testID: 'session-load-error' }).length).toBeGreaterThan(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(mocks.openSession.mock.calls.length).toBe(4);
        mocks.openSession.mockResolvedValue('not-found');
        await act(async () => { renderer.root.findByProps({ testID: 'session-retry' }).props.onPress(); });
        expect(mocks.openSession.mock.calls.length).toBe(5);
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' }).length).toBeGreaterThan(0);
        act(() => renderer.unmount());
    });

    it('hydrates a missing deep link immediately while showing session-scoped loading', async () => {
        const hydration = deferred<boolean>();
        mocks.ensureSessionHydrated.mockReturnValue(hydration.promise);
        let renderer: any;

        await act(async () => { renderer = TestRenderer.create(<SessionView id="deep-session" />); });

        expect(mocks.ensureSessionHydrated).toHaveBeenCalledWith('deep-session');
        expect(renderer.root.findByProps({ testID: 'session-loading' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        expect(mocks.fetchNextHistoryPage).not.toHaveBeenCalled();
        hydration.resolve(true);
        await act(async () => { await hydration.promise; });
        act(() => renderer.unmount());
    });

    it('shows not-found only after the target hydration resolves missing', async () => {
        const hydration = deferred<boolean>();
        mocks.ensureSessionHydrated.mockReturnValue(hydration.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="missing-session" />); });

        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        await act(async () => { hydration.resolve(false); await hydration.promise; });

        expect(renderer.root.findByProps({ testID: 'session-not-found' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('abandons the previous route and ignores its late resolution', async () => {
        const first = deferred<'ready' | 'not-found'>();
        const second = deferred<'ready' | 'not-found'>();
        mocks.openSession
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="first-session" />); });

        await act(async () => { renderer.update(<SessionView id="second-session" />); });
        await act(async () => { first.resolve('not-found'); await first.promise; });

        expect(mocks.abandonSessionRoute).toHaveBeenCalledWith('first-session', first.promise);
        expect(renderer.root.findByProps({ testID: 'session-loading' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        second.resolve('ready');
        await act(async () => { await second.promise; });
        act(() => renderer.unmount());
    });
});
