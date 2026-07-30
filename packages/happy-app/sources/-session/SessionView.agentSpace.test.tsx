import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLauncher } from '@/components/agents/launchAgent';
import {
    AgentSpaceExitButton,
    SessionRightPanelContent,
} from '@/components/agents/SessionAgentSpaceBoundary';
import { SessionView } from './SessionView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    closePanel: vi.fn(),
    pendingCloseCallback: null as (() => void) | null,
    isDataReady: false,
    fileDiffsSidebarEnabled: false,
    runningOnMac: false,
    windowWidth: 390,
    isTablet: false,
    platformOS: 'android',
    spaceAgent: null as AgentLauncher | null,
    useSpaceAgentForSession: vi.fn(),
    enterSpace: vi.fn(),
    exitSpace: vi.fn(),
    routerNavigate: vi.fn(),
    routerPush: vi.fn(),
    routerBack: vi.fn(),
    navigationDispatch: vi.fn(),
    session: {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: 'm1',
            path: '/Users/jacky/health',
            host: 'mac',
            name: 'Mac mini',
            flavor: 'codex',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        presence: 'online',
    },
}));

vi.mock('react-native', () => ({
    AccessibilityInfo: {
        isReduceMotionEnabled: vi.fn(() => new Promise<boolean>(() => {})),
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        get OS() {
            return mocks.platformOS;
        },
        select: (choices: Record<string, unknown>) => choices[mocks.platformOS] ?? choices.default,
    },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: mocks.windowWidth, height: 844 }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Easing: { cubic: 'cubic', out: (value: unknown) => value },
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            accent: '#7c5cbf',
            divider: '#444444',
            header: { tint: '#ffffff' },
            primary: '#7c5cbf',
            shadow: { color: '#000000', opacity: 0.2 },
            surface: '#171717',
            surfaceHigh: '#202020',
            surfacePressed: '#333333',
            text: '#ffffff',
            textSecondary: '#aaaaaa',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/components/rightPanel/SessionCapabilityHub', () => ({ SessionCapabilityHub: 'SessionCapabilityHub' }));
vi.mock('@/components/RightSwipePanelHost', async () => {
    const ReactModule = await import('react');
    return {
        RightSwipePanelHost: ({ panelContent, children }: { panelContent: React.ReactNode; children: React.ReactNode }) => (
            ReactModule.createElement('RightSwipePanelHost', { panelContent }, children, panelContent)
        ),
        useRightSwipePanel: () => ({
            isOpen: true,
            closePanel: (callback?: () => void) => {
                mocks.closePanel(callback);
                mocks.pendingCloseCallback = callback ?? null;
            },
            registerBackHandler: vi.fn(),
        }),
    };
});
vi.mock('@/text', () => ({
    t: (key: string, values?: { current?: number; total?: number; title?: string }) => {
        if (key === 'agentSpace.exit') return 'Exit space';
        if (key.endsWith('paginationAccessibility')) return `Tip ${values?.current} of ${values?.total}`;
        if (key.endsWith('actionAccessibility')) return `Use quick action: ${values?.title}`;
        return key;
    },
}));

vi.mock('@/components/AgentContentView', () => ({ AgentContentView: ({ input }: { input: React.ReactNode }) => input }));
vi.mock('@/components/MessageComposer', () => ({ MessageComposer: 'MessageComposer' }));
vi.mock('@/components/layout', () => ({ layout: { headerMaxWidth: 800 } }));
vi.mock('@/components/autocomplete/suggestions', () => ({ getSuggestions: () => [] }));
vi.mock('@/components/ChatHeaderView', async () => {
    const ReactModule = await import('react');
    return {
        ChatHeaderView: ({ leftSlot, titleSlot, rightSlot, ...props }: { leftSlot?: React.ReactNode; titleSlot?: React.ReactNode; rightSlot?: React.ReactNode; headerContentLeftInset?: number }) => (
            ReactModule.createElement('ChatHeaderView', props, leftSlot, titleSlot, rightSlot)
        ),
    };
});
vi.mock('@/components/SessionHeaderChip', () => ({ SessionHeaderChip: 'SessionHeaderChip' }));
vi.mock('@/components/SessionInfoDropdown', () => ({ SessionInfoDropdown: 'SessionInfoDropdown' }));
vi.mock('@/components/ChatList', () => ({ ChatList: 'ChatList' }));
vi.mock('@/components/Deferred', () => ({ Deferred: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/EmptyMessages', () => ({ EmptyMessages: 'EmptyMessages' }));
vi.mock('@/components/ScreenshotGalleryDrawer', () => ({ ScreenshotGalleryDrawer: 'ScreenshotGalleryDrawer' }));
vi.mock('@/components/FilesSidebar', () => ({ FilesSidebar: 'FilesSidebar' }));
vi.mock('@/components/AllFilesDiffView', () => ({ AllFilesDiffView: 'AllFilesDiffView' }));
vi.mock('@/components/FileViewPanel', () => ({ FileViewPanel: 'FileViewPanel' }));
vi.mock('@/components/diff/PierreDiffView', () => ({ prefetchPierreDiff: vi.fn() }));
vi.mock('@/hooks/useDraft', () => ({ useDraft: () => ({ clearDraft: vi.fn() }) }));
vi.mock('@/hooks/useImagePicker', () => ({
    useImagePicker: () => ({
        selectedImages: [],
        pickImages: vi.fn(),
        removeImage: vi.fn(),
        clearImages: vi.fn(),
        addImages: vi.fn(),
    }),
}));
vi.mock('@/hooks/useSessionQuickActions', () => ({
    useSessionQuickActions: () => ({ canResume: false, resumeSession: vi.fn(), resumingSession: false }),
}));
vi.mock('@/hooks/useAgentSpace', () => ({
    useAgentSpace: () => ({ enter: mocks.enterSpace, exit: mocks.exitSpace }),
    useSpaceAgentForSession: (session: unknown) => mocks.useSpaceAgentForSession(session),
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: { 'session-1': { draft: '' } },
            currentViewingSessionId: null,
            applyLocalSettings: vi.fn(),
            resetSessionAgentOverrides: vi.fn(),
            setCurrentViewingSession: vi.fn(),
        }),
    },
    useIsDataReady: () => mocks.isDataReady,
    useLocalSetting: (key: string) => key === 'acknowledgedCliVersions' ? {} : false,
    useSession: () => mocks.session,
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionUsage: () => undefined,
    useSetting: (key: string) => key === 'fileDiffsSidebar' ? mocks.fileDiffsSidebarEnabled : false,
}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: vi.fn() }));
vi.mock('@/sync/ops.screenshot', () => ({ requestScreenshot: vi.fn() }));
vi.mock('@/sync/screenshotGallery', () => ({
    addScreenshotEntry: vi.fn(),
    saveBase64Png: vi.fn(),
    useHasNewScreenshots: () => ({ hasNew: false }),
}));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => mocks.runningOnMac }));
vi.mock('@/utils/responsive', () => ({
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 52,
    useIsLandscape: () => false,
    useIsTablet: () => mocks.isTablet,
}));
vi.mock('@/utils/sessionUtils', () => ({
    formatPathRelativeToHome: (path: string) => path,
    getResumeCommandBlock: () => null,
    getSessionName: () => 'Health session',
    useSessionStatus: () => ({
        isConnected: true,
        state: 'connected',
        statusColor: '#ffffff',
        statusDotColor: '#00ff00',
        statusText: 'Online',
        isPulsing: false,
    }),
}));
vi.mock('@/utils/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '0.0.0' }));
vi.mock('@/-session/sessionOverlayNav', () => ({
    useOverlayNav: { getState: () => ({ publish: vi.fn(), reset: vi.fn() }) },
}));
vi.mock('expo-application', () => ({ applicationId: 'build.paws.preview' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ dispatch: mocks.navigationDispatch }),
    useRouter: () => ({ back: mocks.routerBack, navigate: mocks.routerNavigate, push: mocks.routerPush }),
}));
vi.mock('@react-navigation/native', () => ({ DrawerActions: { openDrawer: () => ({ type: 'OPEN_DRAWER' }) } }));

function makeAgent(overrides: Partial<AgentLauncher> = {}): AgentLauncher {
    return {
        id: 'health-agent',
        name: 'Health Agent',
        glyph: 'H',
        color: '#0F766E',
        machineId: 'm1',
        path: '~/health',
        presets: [],
        kind: 'standard',
        spaceType: 'health',
        imageStyleIds: [],
        imageVariantsPerStyle: 1,
        ...overrides,
    };
}

describe('SessionView Agent-space boundary', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pendingCloseCallback = null;
        mocks.isDataReady = false;
        mocks.fileDiffsSidebarEnabled = false;
        mocks.runningOnMac = false;
        mocks.windowWidth = 390;
        mocks.isTablet = false;
        mocks.platformOS = 'android';
        mocks.spaceAgent = null;
        mocks.useSpaceAgentForSession.mockImplementation(() => mocks.spaceAgent);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('keeps canonical Agent matching wired into the phone header and panel', () => {
        mocks.spaceAgent = makeAgent();
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(mocks.useSpaceAgentForSession).toHaveBeenCalled();
        expect(mocks.useSpaceAgentForSession.mock.calls.every(([session]) => session === mocks.session)).toBe(true);
        expect(renderer.root.findAllByProps({
            accessibilityLabel: 'Use quick action: agentSpace.companion.actionSleepTitle',
        })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Exit space' })).toHaveLength(1);
        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('lets a long Agent session title shrink before the exit control', () => {
        mocks.isDataReady = true;
        mocks.spaceAgent = makeAgent();
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const title = renderer.root.findAllByType('Text').find((node: any) => node.props.children === 'Health session');
        expect(title).toBeDefined();
        expect(title.props.style).toMatchObject({ flex: 1, minWidth: 0 });
        expect(title.parent.props.style).toMatchObject({ flex: 1, minWidth: 0 });

        act(() => renderer.unmount());
    });

    it('keeps the ordinary phone capability hub and omits Agent exit chrome', () => {
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Exit space' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('preserves the desktop file sidebar instead of mounting the swipe panel', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.runningOnMac = true;
        mocks.windowWidth = 1400;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(1);
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('keeps the session header clear of navigation controls when the desktop file panel is open', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.runningOnMac = true;
        mocks.windowWidth = 1470;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findByType('ChatHeaderView').props.headerContentLeftInset).toBe(130);

        act(() => renderer.unmount());
    });

    it('resolves a matched Agent to companion content and an ordinary session to the capability hub', () => {
        const agent = makeAgent();
        const composerHandleRef = { current: { setMessage: vi.fn() } };
        let matched: any;
        let ordinary: any;

        act(() => {
            matched = TestRenderer.create(
                <SessionRightPanelContent
                    composerHandleRef={composerHandleRef}
                    sessionId="session-1"
                    spaceAgent={agent}
                />,
            );
            ordinary = TestRenderer.create(
                <SessionRightPanelContent
                    composerHandleRef={composerHandleRef}
                    sessionId="session-1"
                    spaceAgent={null}
                />,
            );
        });

        expect(matched.root.findAllByType('ScrollView')).toHaveLength(1);
        expect(matched.root.findAllByProps({
            accessibilityLabel: 'Use quick action: agentSpace.companion.actionSleepTitle',
        })).toHaveLength(1);
        expect(matched.root.findAllByType('SessionCapabilityHub')).toHaveLength(0);
        expect(ordinary.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);

        act(() => {
            matched.unmount();
            ordinary.unmount();
        });
    });

    it('hands a companion action to the composer owner only after panel close completion', () => {
        const composer = { setMessage: vi.fn() };
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SessionRightPanelContent
                    composerHandleRef={{ current: composer }}
                    sessionId="session-1"
                    spaceAgent={makeAgent()}
                />,
            );
        });
        const action = renderer.root.findByProps({
            accessibilityLabel: 'Use quick action: agentSpace.companion.actionSleepTitle',
        });

        act(() => action.props.onPress());
        expect(mocks.closePanel).toHaveBeenCalledTimes(1);
        expect(mocks.pendingCloseCallback).toEqual(expect.any(Function));
        expect(composer.setMessage).not.toHaveBeenCalled();

        act(() => mocks.pendingCloseCallback?.());
        expect(composer.setMessage).toHaveBeenCalledWith('agentSpace.companion.actionSleepPrompt');

        act(() => renderer.unmount());
    });

    it('renders a localized Agent-space exit button and forwards its action', () => {
        const onPress = vi.fn();
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <AgentSpaceExitButton color="#FFFFFF" onPress={onPress} />,
            );
        });
        const exitButton = renderer.root.findByProps({ accessibilityLabel: 'Exit space' });

        expect(exitButton.props.accessibilityRole).toBe('button');
        act(() => exitButton.props.onPress());
        expect(onPress).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });
});
