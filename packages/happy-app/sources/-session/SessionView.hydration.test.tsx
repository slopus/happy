import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { SessionView } from './SessionView';
import { SessionRouteAbandonedError, SessionRouteCoordinationError, SessionRouteOwnership } from '@/sync/sessionRouteOwnership';

const mocks = vi.hoisted(() => ({
    abandonSessionRoute: vi.fn(),
    beginSessionRoute: vi.fn(),
    isSessionRouteOwner: vi.fn(),
    promoteSessionRoute: vi.fn(),
    leaveSessionRoute: vi.fn(),
    setCurrentViewingSession: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    fetchNextHistoryPage: vi.fn(),
    openSession: vi.fn(),
    session: null as any,
    sessionListeners: new Set<() => void>(),
    messages: [] as any[],
    messagesLoaded: false,
    messagesAtLatest: true,
    latestVerifiedOwnerEpoch: null as number | null,
    currentRouteOwnerEpoch: null as number | null,
    autoVerifyRouteOwner: true,
    focusContext: null as unknown as React.Context<boolean>,
    currentViewingSessionId: null as string | null,
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
vi.mock('react-native-gesture-handler', () => ({ ScrollView: 'ScrollView' }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: () => ({ isVisible: false, height: 0 }) }));
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
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    mocks.focusContext = ReactModule.createContext(true);
    return {
        DrawerActions: { openDrawer: () => ({ type: 'OPEN' }) },
        useIsFocused: () => ReactModule.useContext(mocks.focusContext),
    };
});

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: mocks.session ? { [mocks.session.id]: mocks.session } : {}, currentViewingSessionId: mocks.currentViewingSessionId, setCurrentViewingSession: mocks.setCurrentViewingSession }) },
    useIsDataReady: () => true,
    useLocalSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useLocalSettingMutable: () => [false, vi.fn()],
    useMachine: () => null,
    useSession: () => React.useSyncExternalStore(
        listener => { mocks.sessionListeners.add(listener); return () => { mocks.sessionListeners.delete(listener); }; },
        () => mocks.session,
    ),
    useSessionMessages: () => ({
        messages: mocks.messages,
        isLoaded: mocks.messagesLoaded,
        isAtLatest: mocks.messagesAtLatest,
        latestVerifiedOwnerEpoch: mocks.latestVerifiedOwnerEpoch,
    }),
    useSessionUsage: () => undefined,
    useSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useSettingUpdater: () => vi.fn(),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        abandonSessionRoute: mocks.abandonSessionRoute,
        beginSessionRoute: mocks.beginSessionRoute,
        isSessionRouteOwner: mocks.isSessionRouteOwner,
        promoteSessionRoute: mocks.promoteSessionRoute,
        leaveSessionRoute: mocks.leaveSessionRoute,
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
vi.mock('@/hooks/useSessionResultSyncing', () => ({ useSessionResultSyncing: () => false }));
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
vi.mock('@/hooks/useSessionManagementPreferences', () => ({
    useSessionManagementPreferences: () => ({ isPinned: () => false, togglePinned: vi.fn() }),
}));
vi.mock('@/hooks/useSessionTaskPermission', () => ({ useSessionTaskPermission: () => ({}) }));
vi.mock('@/hooks/useSessionWorkingDirectory', () => ({ useSessionWorkingDirectory: () => ({}) }));
vi.mock('@/hooks/useDraft', () => ({ useDraft: () => ({ clearDraft: vi.fn(), updateDraft: vi.fn() }) }));
vi.mock('@/hooks/useImagePicker', () => ({ useImagePicker: () => ({ selectedImages: [] }) }));

// Keep the existing host selector while exercising the real content/placeholder
// mounting behavior. In particular, content must cross the real Deferred timer.
vi.mock('@/components/AgentContentView', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/AgentContentView')>();
    return { AgentContentView: (props: React.ComponentProps<typeof actual.AgentContentView>) => (
        React.createElement('AgentContentView', {}, React.createElement(actual.AgentContentView, props))
    ) };
});
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
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

function installLatestPaintHarness() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const markFreshLatestMessageComplete = vi.fn();
    const markRouteNavigation = vi.fn();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalProbe = (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe;
    (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (callback) => {
        const frame = ++nextFrame;
        frames.set(frame, callback);
        return frame;
    };
    (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = (frame) => {
        frames.delete(frame);
    };
    (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
        markFreshLatestMessageComplete,
        markRouteNavigation,
    };

    return {
        markFreshLatestMessageComplete,
        markRouteNavigation,
        runAllFrames: () => {
            const queued = [...frames.values()];
            frames.clear();
            queued.forEach((callback) => callback(0));
        },
        discardAllFrames: () => frames.clear(),
        restore: () => {
            (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = originalRequestAnimationFrame;
            (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = originalCancelAnimationFrame;
            if (originalProbe) {
                (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = originalProbe;
            } else {
                delete (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe;
            }
        },
    };
}

describe('SessionView deep-link hydration', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
        mocks.session = null;
        mocks.messages = [];
        mocks.messagesLoaded = false;
        mocks.messagesAtLatest = true;
        mocks.latestVerifiedOwnerEpoch = null;
        mocks.autoVerifyRouteOwner = true;
        mocks.currentViewingSessionId = null;
        mocks.setCurrentViewingSession.mockImplementation((id: string | null) => { mocks.currentViewingSessionId = id; });
        const owners = new SessionRouteOwnership();
        mocks.beginSessionRoute.mockImplementation((id: string) => {
            const owner = owners.enter(id);
            mocks.currentRouteOwnerEpoch = owner.ownerEpoch;
            if (mocks.autoVerifyRouteOwner) mocks.latestVerifiedOwnerEpoch = owner.ownerEpoch;
            return owner;
        });
        mocks.isSessionRouteOwner.mockImplementation((owner) => owners.owns(owner));
        mocks.promoteSessionRoute.mockImplementation((owner) => owners.promote(owner));
        mocks.leaveSessionRoute.mockImplementation((owner) => owners.leave(owner));
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

    it('keeps the parent route owned when a cold-loaded child replays its mount effects', async () => {
        const opening = deferred<'ready'>();
        mocks.openSession.mockReturnValue(opening.promise);
        mocks.session = {
            id: 'strict-cold', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<React.StrictMode><SessionView id="strict-cold" /></React.StrictMode>); });
            expect(renderer.root.findAllByProps({ testID: 'session-loading' }).length).toBeGreaterThan(0);
            const owner = mocks.beginSessionRoute.mock.results.at(-1)!.value;
            mocks.messagesLoaded = true;
            await act(async () => { opening.resolve('ready'); });
            await act(async () => { await vi.advanceTimersByTimeAsync(20); });
            expect(renderer.root.findAllByType('MessageComposer')).toHaveLength(1);
            expect(mocks.isSessionRouteOwner(owner)).toBe(true);
            expect(mocks.currentViewingSessionId).toBe('strict-cold');
        } finally { act(() => renderer?.unmount()); }
    });

    it('restores the retained main session owner after a modal session loses focus without remounting its composer', async () => {
        mocks.messagesLoaded = true;
        mocks.session = {
            id: 'main-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        const Focus = mocks.focusContext.Provider;
        const tree = (modal: boolean) => <>
            <Focus value={!modal}><SessionView id="main-session" /></Focus>
            <Focus value={modal}>{modal ? <SessionView id="modal-session" /> : null}</Focus>
        </>;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(tree(false)); });
        const mainComposer = renderer.root.findByType('MessageComposer');
        const firstOwner = mocks.beginSessionRoute.mock.results[0].value;
        expect(mocks.currentViewingSessionId).toBe('main-session');

        await act(async () => { renderer.update(tree(true)); });
        expect(mocks.currentViewingSessionId).toBe('modal-session');
        expect(renderer.root.findAllByType('MessageComposer')[0]).toBe(mainComposer);

        await act(async () => { renderer.update(tree(false)); });
        expect(mocks.beginSessionRoute.mock.calls.map(([id]) => id)).toEqual(['main-session', 'modal-session', 'main-session']);
        const restoredOwner = mocks.beginSessionRoute.mock.results.at(-1)!.value;
        expect(restoredOwner.ownerEpoch).toBeGreaterThan(firstOwner.ownerEpoch);
        expect(mocks.promoteSessionRoute).toHaveBeenLastCalledWith(restoredOwner);
        expect(mocks.currentViewingSessionId).toBe('main-session');
        expect(renderer.root.findByType('MessageComposer')).toBe(mainComposer);
        act(() => renderer.unmount());
        expect(mocks.currentViewingSessionId).toBeNull();
    });

    it('does not acquire an unfocused route and ignores its late hydration after focus moves away', async () => {
        const firstOpening = deferred<'not-found'>();
        const Focus = mocks.focusContext.Provider;
        const tree = (focused: boolean) => <Focus value={focused}><SessionView id="retained-session" /></Focus>;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(tree(false)); });
        expect(mocks.beginSessionRoute).not.toHaveBeenCalled();
        expect(mocks.openSession).not.toHaveBeenCalled();

        mocks.openSession.mockReturnValueOnce(firstOpening.promise);
        await act(async () => { renderer.update(tree(true)); });
        const firstOwner = mocks.beginSessionRoute.mock.results[0].value;
        await act(async () => { renderer.update(tree(false)); });
        expect(mocks.leaveSessionRoute).toHaveBeenCalledWith(firstOwner);
        await act(async () => { firstOpening.resolve('not-found'); await firstOpening.promise; });
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();

        await act(async () => { renderer.update(tree(true)); });
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(2);
        expect(mocks.openSession).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
    });

    it('bounds transient retries and exposes a deliberate retry action without preloaded messages', async () => {
        vi.useFakeTimers();
        mocks.openSession.mockRejectedValue(new Error('synthetic-network-failure'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="retry-session" />); });
        expect(renderer.root.findAllByProps({ testID: 'session-retrying' }).length).toBeGreaterThan(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(mocks.openSession.mock.calls.length).toBe(4);
        expect(mocks.openSession.mock.calls.map(call => call[2]?.retry ?? false)).toEqual([false, true, true, true]);
        expect(renderer.root.findAllByProps({ testID: 'session-load-error' }).length).toBeGreaterThan(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(mocks.openSession.mock.calls.length).toBe(4);
        mocks.openSession.mockResolvedValue('not-found');
        await act(async () => { renderer.root.findByProps({ testID: 'session-retry' }).props.onPress(); });
        expect(mocks.openSession.mock.calls.length).toBe(5);
        expect(mocks.openSession.mock.calls[4][2]).toEqual({ retry: true });
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' }).length).toBeGreaterThan(0);
        act(() => renderer.unmount());
    });

    it('keeps the failed route owner reserved until the delayed retry acquires its replacement', async () => {
        const retry = deferred<'ready'>();
        mocks.openSession
            .mockRejectedValueOnce(new Error('transient-network-failure'))
            .mockReturnValueOnce(retry.promise);
        let renderer: any;

        await act(async () => { renderer = TestRenderer.create(<SessionView id="reserved-retry-session" />); });
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(1);
        expect(mocks.leaveSessionRoute).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(99); });
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(1);
        expect(mocks.leaveSessionRoute).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(2);
        expect(mocks.openSession.mock.calls[1][2]).toEqual({ retry: true });
        act(() => renderer.unmount());
    });

    it('hydrates a missing deep link immediately while showing session-scoped loading', async () => {
        const hydration = deferred<boolean>();
        mocks.ensureSessionHydrated.mockReturnValue(hydration.promise);
        let renderer: any;

        await act(async () => { renderer = TestRenderer.create(<SessionView id="deep-session" />); });

        expect(mocks.ensureSessionHydrated).toHaveBeenCalledWith('deep-session');
        expect(mocks.openSession).toHaveBeenCalledWith('deep-session', expect.objectContaining({ sessionId: 'deep-session', phase: 'opening' }));
        expect(mocks.promoteSessionRoute).not.toHaveBeenCalled();
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'session-loading' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        expect(mocks.fetchNextHistoryPage).not.toHaveBeenCalled();
        hydration.resolve(true);
        await act(async () => { await hydration.promise; });
        act(() => renderer.unmount());
    });

    it('reacquires route ownership before deciding that an abandoned target is missing', async () => {
        vi.useFakeTimers();
        mocks.openSession
            .mockRejectedValueOnce(new SessionRouteAbandonedError())
            .mockResolvedValueOnce('not-found');
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="deleted-session" />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(mocks.openSession).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByProps({ testID: 'session-not-found' })).toBeTruthy();
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('shows deleted when background reconciliation removes an already readable session', async () => {
        mocks.session = {
            id: 'deleted-while-reading', seq: 3, active: false, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        mocks.messagesLoaded = true;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="deleted-while-reading" />); });
        expect(renderer.root.findAllByProps({ testID: 'session-loading' })).toHaveLength(0);
        await act(async () => {
            mocks.session = null;
            mocks.messagesLoaded = false;
            mocks.sessionListeners.forEach(notify => notify());
        });
        expect(renderer.root.findAllByProps({ testID: 'session-loading' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'session-not-found' })).toBeTruthy();
        expect(renderer.root.findAllByType('MessageComposer')).toHaveLength(0);
        expect(mocks.openSession).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it.each(['cached', 'hydrated'] as const)('recovers an abandoned %s session under a fresh route owner', async (source) => {
        vi.useFakeTimers();
        const session = {
            id: 'abandoned-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        const opening = deferred<'ready'>();
        mocks.openSession.mockReturnValueOnce(opening.promise).mockResolvedValueOnce('ready');
        if (source === 'cached') mocks.session = session;
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="abandoned-session" />); });
        expect(renderer.root.findAllByType('MessageComposer')).toHaveLength(0);
        if (source === 'hydrated') mocks.session = session;
        await act(async () => { opening.reject(new SessionRouteAbandonedError()); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MessageComposer')).toHaveLength(1);
        expect(mocks.openSession).toHaveBeenCalledTimes(2);
        expect(mocks.promoteSessionRoute).toHaveBeenCalledTimes(1);
        expect(mocks.setCurrentViewingSession).toHaveBeenCalledWith('abandoned-session');
        act(() => renderer.unmount());
    });

    it('exposes exhausted coordination without spending the network retry budget', async () => {
        vi.useFakeTimers();
        mocks.session = {
            id: 'exhausted-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        mocks.openSession.mockRejectedValue(new SessionRouteCoordinationError());
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="exhausted-session" />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(mocks.openSession).toHaveBeenCalledTimes(1);
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(1);
        expect(renderer.root.findByProps({ testID: 'session-load-error' })).toBeTruthy();
        expect(renderer.root.findAllByType('MessageComposer')).toHaveLength(0);
        expect(mocks.promoteSessionRoute).not.toHaveBeenCalled();
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
        mocks.openSession.mockResolvedValue('ready');
        await act(async () => { renderer.root.findByProps({ testID: 'session-retry' }).props.onPress(); });
        expect(mocks.beginSessionRoute).toHaveBeenCalledTimes(2);
        expect(mocks.setCurrentViewingSession).toHaveBeenCalledWith('exhausted-session');
        act(() => renderer.unmount());
    });

    it('promotes and marks read only after the ready page mounts its loaded component', async () => {
        const opening = deferred<'ready'>();
        mocks.openSession.mockReturnValue(opening.promise);
        mocks.session = {
            id: 'loaded-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="loaded-session" />); });
        expect(mocks.promoteSessionRoute).not.toHaveBeenCalled();
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
        await act(async () => { opening.resolve('ready'); await opening.promise; });
        const owner = mocks.beginSessionRoute.mock.results[0].value;
        expect(mocks.promoteSessionRoute).toHaveBeenCalledWith(owner);
        expect(mocks.setCurrentViewingSession).toHaveBeenCalledWith('loaded-session');
        expect(mocks.promoteSessionRoute.mock.invocationCallOrder[0]).toBeLessThan(mocks.setCurrentViewingSession.mock.invocationCallOrder[0]);
        act(() => renderer.unmount());
    });

    it('keeps an already loaded conversation visible while its latest page revalidates', async () => {
        const opening = deferred<'ready'>();
        mocks.openSession.mockReturnValue(opening.promise);
        mocks.messagesLoaded = true;
        mocks.session = {
            id: 'warm-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };

        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<SessionView id="warm-session" />); });

        expect(renderer.root.findAllByProps({ testID: 'session-loading' })).toHaveLength(0);
        expect(renderer.root.findAllByType('AgentContentView')).toHaveLength(1);

        await act(async () => { opening.resolve('ready'); await opening.promise; });
        expect(renderer.root.findAllByType('AgentContentView')).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('paints newborn local content once while validation stays pending and preserves it through retry and failure', async () => {
        // Catches local projection waiting for network readiness or hiding background failures.
        vi.useFakeTimers();
        const opening = deferred<'ready'>();
        const paint = installLatestPaintHarness();
        mocks.openSession.mockReturnValueOnce(opening.promise).mockRejectedValue(new Error('offline'));
        mocks.messagesLoaded = false;
        mocks.messages = [{ id: 'local-1', kind: 'user-text', text: 'hello' }];
        mocks.session = {
            id: 'newborn-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="newborn-session" />); });
            expect(renderer.root.findAllByProps({ testID: 'session-loading' })).toHaveLength(0);
            const chat = renderer.root.findByType('AgentContentView');
            paint.runAllFrames();
            expect(paint.markRouteNavigation).toHaveBeenCalledTimes(1);
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
            await act(async () => { opening.reject(new Error('offline')); });
            expect(renderer.root.findByProps({ testID: 'session-retrying-cached' })).toBeTruthy();
            await act(async () => { await vi.advanceTimersByTimeAsync(850); });
            expect(mocks.openSession).toHaveBeenCalledTimes(4);
            expect(renderer.root.findByProps({ testID: 'session-load-error-cached' })).toBeTruthy();
            expect(renderer.root.findByType('AgentContentView')).toBe(chat);
            const recovery = deferred<'ready'>();
            mocks.openSession.mockReturnValueOnce(recovery.promise);
            await act(async () => { renderer.root.findByProps({ testID: 'session-retry-cached' }).props.onPress(); });
            expect(mocks.openSession.mock.calls[4][2]).toEqual({ retry: true });
            expect(renderer.root.findByType('AgentContentView')).toBe(chat);
            mocks.messagesLoaded = true;
            await act(async () => { recovery.resolve('ready'); });
            paint.runAllFrames();
            expect(paint.markRouteNavigation).toHaveBeenCalledTimes(1);
            expect(paint.markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
            vi.useRealTimers();
        }
    });

    it('rejects a released owner paint before the first frame and paints the successful retry once', async () => {
        vi.useFakeTimers();
        const opening = deferred<'ready'>();
        const retry = deferred<'ready'>();
        const paint = installLatestPaintHarness();
        mocks.openSession.mockReturnValueOnce(opening.promise).mockReturnValueOnce(retry.promise);
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'local-1', kind: 'user-text', text: 'hello' }];
        mocks.session = {
            id: 'released-paint', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="released-paint" />); });
            const chat = renderer.root.findByType('AgentContentView');
            await act(async () => { opening.reject(new Error('offline-before-paint')); });
            expect(renderer.root.findByType('AgentContentView')).toBe(chat);
            expect(renderer.root.findByProps({ testID: 'session-retrying-cached' })).toBeTruthy();
            paint.runAllFrames();
            expect(paint.markRouteNavigation).not.toHaveBeenCalled();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();

            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            expect(mocks.openSession).toHaveBeenCalledTimes(2);
            await act(async () => { retry.resolve('ready'); });
            expect(renderer.root.findByType('AgentContentView')).toBe(chat);
            paint.runAllFrames();
            paint.runAllFrames();
            expect(paint.markRouteNavigation).toHaveBeenCalledTimes(1);
            expect(paint.markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
            vi.useRealTimers();
        }
    });

    it('cancels a local route paint frame when another session replaces its owner', async () => {
        const paint = installLatestPaintHarness();
        mocks.openSession.mockReturnValue(new Promise(() => {}));
        mocks.messages = [{ id: 'local-1' }];
        mocks.session = {
            id: 'old-local', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="old-local" />); });
            await act(async () => { renderer.update(<SessionView id="new-local" />); });
            paint.runAllFrames();
            expect(paint.markRouteNavigation).not.toHaveBeenCalled();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
        }
    });

    it('does not verify a cached latest paint before its route revalidation resolves', async () => {
        // Catches cache-first rendering authorizing the strict verified marker before openSession is ready.
        const opening = deferred<'ready'>();
        const { markFreshLatestMessageComplete, restore, runAllFrames } = installLatestPaintHarness();
        mocks.openSession.mockReturnValue(opening.promise);
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'warm-paint-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;

        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="warm-paint-session" />); });

            expect(renderer.root.findAllByProps({ testID: 'session-loading' })).toHaveLength(0);
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(0);
            // Keep route verification pending while the real message boundary mounts.
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(1);
            runAllFrames();
            expect(markFreshLatestMessageComplete).not.toHaveBeenCalled();
        } finally {
            act(() => renderer?.unmount());
            restore();
        }
    });

    it('verifies a ready owner with no message delta on its next frame', async () => {
        // Catches readiness being tied to a new message instead of the current route owner's completed revalidation.
        const opening = deferred<'ready'>();
        const { discardAllFrames, markFreshLatestMessageComplete, restore, runAllFrames } = installLatestPaintHarness();
        mocks.openSession.mockReturnValue(opening.promise);
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'zero-delta-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;

        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="zero-delta-session" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(1);
            discardAllFrames();
            await act(async () => { opening.resolve('ready'); await opening.promise; });

            runAllFrames();
            expect(markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            restore();
        }
    });

    it('keeps a historical cached window visible without certifying latest paint', async () => {
        // Catches a completed local/history render being mistaken for the
        // current owner's verified latest commit at the real Deferred boundary.
        const paint = installLatestPaintHarness();
        mocks.openSession.mockResolvedValue('ready');
        mocks.messagesLoaded = true;
        mocks.messagesAtLatest = false;
        mocks.latestVerifiedOwnerEpoch = null;
        mocks.autoVerifyRouteOwner = false;
        mocks.messages = [{ id: 'historical-message' }];
        mocks.session = {
            id: 'historical-window', seq: 400, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="historical-window" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(1);
            paint.runAllFrames();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
        }
    });

    it('does not let an abandoned cached owner verify after a different route mounts', async () => {
        // Catches A's already-authorized queued frame claiming the verified marker after B replaces A.
        const first = deferred<'ready'>();
        const second = deferred<'ready'>();
        const { markFreshLatestMessageComplete, restore, runAllFrames } = installLatestPaintHarness();
        mocks.openSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'owner-a', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;

        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="owner-a" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            await act(async () => { first.resolve('ready'); await first.promise; });
            mocks.session = { ...mocks.session, id: 'owner-b' };
            await act(async () => { renderer.update(<SessionView id="owner-b" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });

            runAllFrames();
            expect(markFreshLatestMessageComplete).not.toHaveBeenCalled();
            await act(async () => { second.resolve('ready'); await second.promise; });
            runAllFrames();
            expect(markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            restore();
        }
    });

    it('cancels an authorized owner frame when a same-session remount replaces it', async () => {
        // Catches A's already-authorized queued frame surviving a same-ID remount with B's owner epoch.
        const first = deferred<'ready'>();
        const second = deferred<'ready'>();
        const { markFreshLatestMessageComplete, restore, runAllFrames } = installLatestPaintHarness();
        mocks.openSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'retry-paint-session', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            thinking: false, thinkingAt: 0,
        };
        let renderer: any;

        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="retry-paint-session" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            await act(async () => { first.resolve('ready'); await first.promise; });
            act(() => renderer.unmount());
            await act(async () => { renderer = TestRenderer.create(<SessionView id="retry-paint-session" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });

            runAllFrames();
            expect(markFreshLatestMessageComplete).not.toHaveBeenCalled();
            await act(async () => { second.resolve('ready'); await second.promise; });
            runAllFrames();
            expect(markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            restore();
        }
    });

    it('waits for the actual deferred message subtree to mount before verifying latest paint', async () => {
        // A ready store is not proof that Deferred has committed ChatList.
        const paint = installLatestPaintHarness();
        mocks.openSession.mockResolvedValue('ready');
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'deferred-paint', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="deferred-paint" />); });
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(0);
            paint.runAllFrames();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(9); });
            paint.runAllFrames();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            expect(renderer.root.findAllByType('ChatList')).toHaveLength(1);
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
            paint.runAllFrames();
            expect(paint.markFreshLatestMessageComplete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
        }
    });

    it('rejects a queued verified frame when a different live owner takes over the retained tree', async () => {
        // Route ownership can change before React commits an update or cleanup.
        const paint = installLatestPaintHarness();
        mocks.openSession.mockResolvedValue('ready');
        mocks.messagesLoaded = true;
        mocks.messages = [{ id: 'cached-message' }];
        mocks.session = {
            id: 'retained-paint', seq: 3, active: true, activeAt: 10,
            createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
            metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        };
        let renderer: any;
        try {
            await act(async () => { renderer = TestRenderer.create(<SessionView id="retained-paint" />); });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            const chat = renderer.root.findByType('ChatList');
            mocks.beginSessionRoute('next-owner');
            expect(renderer.root.findByType('ChatList')).toBe(chat);
            paint.runAllFrames();
            expect(paint.markFreshLatestMessageComplete).not.toHaveBeenCalled();
            expect(paint.markRouteNavigation).not.toHaveBeenCalled();
        } finally {
            act(() => renderer?.unmount());
            paint.restore();
        }
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

        expect(mocks.leaveSessionRoute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'first-session' }));
        expect(renderer.root.findByProps({ testID: 'session-loading' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'session-not-found' })).toHaveLength(0);
        second.resolve('ready');
        await act(async () => { await second.promise; });
        act(() => renderer.unmount());
    });

    it('paints only the matching route after its session route becomes ready', async () => {
        // Catches a stale or loading route recording a browser paint before it is interactive.
        const opening = deferred<'ready' | 'not-found'>();
        const frames: FrameRequestCallback[] = [];
        const paints: string[] = [];
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (callback) => {
            frames.push(callback);
            return frames.length;
        };
        (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = () => undefined;
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markRouteNavigation: () => paints.push('painted'),
        };
        mocks.openSession.mockReturnValue(opening.promise);
        let renderer: any;
        try {
            mocks.session = {
                id: 'paint-session', seq: 3, active: true, activeAt: 10,
                createdAt: 1, updatedAt: 10, metadata: { path: '/test', host: 'test' },
                metadataVersion: 1, agentState: null, agentStateVersion: 0,
                thinking: false, thinkingAt: 0,
            };
            await act(async () => { renderer = TestRenderer.create(<SessionView id="paint-session" />); });
            expect(frames).toHaveLength(0);

            await act(async () => { opening.resolve('ready'); await opening.promise; });
            expect(frames).toHaveLength(1);
            frames[0](0);
            expect(paints).toEqual(['painted']);
        } finally {
            act(() => renderer?.unmount());
            (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = originalRequestAnimationFrame;
            (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = originalCancelAnimationFrame;
            delete (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe;
        }
    });
});
