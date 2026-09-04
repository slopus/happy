import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLauncher } from '@/components/agents/launchAgent';
import type { Message } from '@/sync/typesMessage';
import {
    AgentSpaceExitButton,
    SessionRightPanelContent,
} from '@/components/agents/SessionAgentSpaceBoundary';
import {
    getDesktopRightPanelWidth,
    getPersistentHeaderContentInset,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
} from '@/utils/desktopNavigationLayout';
import { SessionView } from './SessionView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    closePanel: vi.fn(),
    pendingCloseCallback: null as (() => void) | null,
    isDataReady: false,
    sessionAvailable: true,
    fileDiffsSidebarEnabled: false,
    runningOnMac: false,
    windowWidth: 390,
    isTablet: false,
    platformOS: 'android',
    desktopRightPanelCollapsed: false,
    globalRightSidebarShortcut: undefined as (() => void) | undefined,
    setDesktopRightPanelCollapsed: vi.fn(),
    updateSidebarOrganization: vi.fn(),
    sidebarOrganization: {
        lists: [],
        tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
        sessions: { 'session-1': { listId: null, tagIds: ['product'] } },
    } as any,
    spaceAgent: null as AgentLauncher | null,
    useSpaceAgentForSession: vi.fn(),
    enterSpace: vi.fn(),
    exitSpace: vi.fn(),
    routerNavigate: vi.fn(),
    routerPush: vi.fn(),
    routerBack: vi.fn(),
    navigationDispatch: vi.fn(),
    modalShow: vi.fn(),
    styleUseVariants: vi.fn(),
    switchDirectory: vi.fn(),
    renameSession: vi.fn(),
    renameSessionToTitle: vi.fn(),
    sessionAbort: vi.fn(),
    requestScreenshot: vi.fn(),
    imageViewerOpen: vi.fn(),
    overlayPublish: vi.fn(),
    overlayReset: vi.fn(),
    suspendFileViewPanel: false,
    fileViewPanelSuspender: null as Promise<void> | null,
    sessionMessages: [] as Message[],
    openSubagent: undefined as ((selection: {
        id: string;
        title: string | null;
        status: 'running' | 'completed' | 'failed' | 'cancelled';
    }) => void) | undefined,
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
    TextInput: 'TextInput',
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
            groupped: { background: '#111111' },
            header: { tint: '#ffffff' },
            primary: '#7c5cbf',
            shadow: { color: '#000000', opacity: 0.2 },
            surface: '#171717',
            surfaceHigh: '#202020',
            surfacePressed: '#333333',
            text: '#ffffff',
            textSecondary: '#aaaaaa',
            button: {
                primary: {
                    background: '#7c5cbf',
                    tint: '#ffffff',
                },
            },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => {
                const styles = typeof factory === 'function'
                    ? (factory as (value: typeof theme) => object)(theme)
                    : factory;
                return { ...styles as object, useVariants: mocks.styleUseVariants };
            },
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
        RightSwipePanelHost: ({ panelContent, children, ...props }: { panelContent: React.ReactNode; children: React.ReactNode }) => (
            ReactModule.createElement('RightSwipePanelHost', { panelContent, ...props }, children, panelContent)
        ),
        useRightSwipePanel: () => ({
            isOpen: true,
            closePanel: (callback?: () => void) => {
                mocks.closePanel(callback);
                mocks.pendingCloseCallback = callback ?? null;
            },
            focusPanel: vi.fn(),
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

vi.mock('@/components/AgentContentView', async () => {
    const ReactModule = await import('react');
    return {
        AgentContentView: ({ children, content, input }: {
            children?: React.ReactNode;
            content?: React.ReactNode;
            input: React.ReactNode;
        }) => ReactModule.createElement('AgentContentView', {}, content ?? children, input),
    };
});
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
vi.mock('@/components/PublicSessionShareDialog', () => ({ PublicSessionShareDialog: 'PublicSessionShareDialog' }));
vi.mock('@/components/SessionOrganizerDialog', () => ({ SessionOrganizerDialog: 'SessionOrganizerDialog' }));
vi.mock('@/components/ChatList', async () => {
    const ReactModule = await import('react');
    const { useSubagentInspector } = await import('@/components/subagent/SubagentInspectorContext');
    return {
        ChatList: () => {
            const inspector = useSubagentInspector();
            mocks.openSubagent = inspector?.open;
            return ReactModule.createElement('ChatList');
        },
    };
});
vi.mock('@/components/subagent/SubagentInspectorPanel', async () => {
    const ReactModule = await import('react');
    return {
        SubagentInspectorPanel: (props: Record<string, unknown>) => (
            ReactModule.createElement('SubagentInspectorPanel', props)
        ),
    };
});
vi.mock('@/components/Deferred', () => ({ Deferred: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/EmptyMessages', () => ({ EmptyMessages: 'EmptyMessages' }));
vi.mock('@/components/FilesSidebar', () => ({ FilesSidebar: 'FilesSidebar' }));
vi.mock('@/components/DesktopPresenceTransition', async () => {
    const ReactModule = await import('react');
    return {
        DesktopPresenceTransition: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
            ReactModule.createElement('DesktopPresenceTransition', props, children)
        ),
    };
});
vi.mock('@/components/AllFilesDiffView', () => ({ AllFilesDiffView: 'AllFilesDiffView' }));
vi.mock('@/components/FileViewPanel', async () => {
    const ReactModule = await import('react');
    return {
        FileViewPanel: (props: Record<string, unknown>) => {
            if (mocks.suspendFileViewPanel && mocks.fileViewPanelSuspender) {
                throw mocks.fileViewPanelSuspender;
            }
            return ReactModule.createElement('FileViewPanel', props);
        },
    };
});
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
vi.mock('@/hooks/useGlobalKeyboard', () => ({
    useGlobalKeyboard: (_handler: (() => void) | undefined, options: { onToggleRightSidebar?: () => void }) => {
        mocks.globalRightSidebarShortcut = options.onToggleRightSidebar;
    },
}));
vi.mock('@/hooks/useSessionQuickActions', () => ({
    useSessionQuickActions: () => ({
        canResume: false,
        renameSession: mocks.renameSession,
        renameSessionToTitle: mocks.renameSessionToTitle,
        renamingSession: false,
        resumeSession: vi.fn(),
        resumingSession: false,
    }),
}));
vi.mock('@/hooks/useSessionWorkingDirectory', () => ({
    useSessionWorkingDirectory: () => ({
        currentPath: mocks.session.metadata.path,
        currentPathLabel: '~/health',
        fullPath: mocks.session.metadata.path,
        homeDir: '/Users/jacky',
        machineId: mocks.session.metadata.machineId,
        machineOnline: true,
        recentPaths: [],
        switching: false,
        switchDirectory: mocks.switchDirectory,
    }),
}));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({
    useDesktopWorkspaceLayout: () => ({
        enabled: mocks.isTablet,
        leftVisible: mocks.isTablet,
        leftMaximumWidth: 640,
        leftWidth: mocks.isTablet ? Math.min(Math.max(Math.floor(mocks.windowWidth * 0.3), 250), 360) : 0,
        rightPanelAvailable: mocks.isTablet
            && (mocks.platformOS === 'web' || mocks.runningOnMac)
            && mocks.windowWidth >= 1100,
        rightExpandedWidth: getDesktopRightPanelWidth(mocks.windowWidth),
        rightVisible: !mocks.desktopRightPanelCollapsed,
        rightMaximumWidth: 640,
        rightWidth: getDesktopRightPanelWidth(mocks.windowWidth),
        resizingSide: null,
        beginPanelResize: vi.fn(),
        continuePanelResize: vi.fn(),
        endPanelResize: vi.fn(),
        resizePanelBy: vi.fn(),
        toggleLeftSidebar: vi.fn(),
        toggleRightSidebar: vi.fn(),
    }),
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
    useLocalSetting: (key: string) => {
        if (key === 'acknowledgedCliVersions') return {};
        if (key === 'desktopRightPanelCollapsed') return mocks.desktopRightPanelCollapsed;
        if (key === 'sidebarOrganization') return mocks.sidebarOrganization;
        return false;
    },
    useLocalSettingMutable: (key: string) => {
        if (key === 'desktopRightPanelCollapsed') {
            return [mocks.desktopRightPanelCollapsed, mocks.setDesktopRightPanelCollapsed];
        }
        return [false, vi.fn()];
    },
    useSettingUpdater: () => mocks.updateSidebarOrganization,
    useMachine: () => null,
    useSession: () => mocks.sessionAvailable ? mocks.session : null,
    useSessionMessages: () => ({ messages: mocks.sessionMessages, isLoaded: true }),
    useSessionUsage: () => undefined,
    useSetting: (key: string) => {
        if (key === 'fileDiffsSidebar') return mocks.fileDiffsSidebarEnabled;
        if (key === 'sidebarOrganization') return mocks.sidebarOrganization;
        return false;
    },
}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: mocks.sessionAbort }));
vi.mock('@/sync/ops.screenshot', () => ({ requestScreenshot: mocks.requestScreenshot }));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: mocks.imageViewerOpen } }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), show: mocks.modalShow } }));
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
    useOverlayNav: {
        getState: () => ({ publish: mocks.overlayPublish, reset: mocks.overlayReset }),
    },
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
        mocks.sessionAvailable = true;
        mocks.fileDiffsSidebarEnabled = false;
        mocks.runningOnMac = false;
        mocks.windowWidth = 390;
        mocks.isTablet = false;
        mocks.platformOS = 'android';
        mocks.desktopRightPanelCollapsed = false;
        mocks.sidebarOrganization = {
            lists: [],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: null, tagIds: ['product'] } },
        };
        mocks.suspendFileViewPanel = false;
        mocks.fileViewPanelSuspender = null;
        mocks.sessionMessages = [];
        mocks.openSubagent = undefined;
        mocks.globalRightSidebarShortcut = undefined;
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
        expect(renderer.root.findByType('RightSwipePanelHost').props.panelAccessibilityLabel)
            .toBe('agentSpace.companion.panelTitle');

        act(() => renderer.unmount());
    });

    it('keeps the composer abort pending until the session RPC settles', () => {
        mocks.isDataReady = true;
        const pendingAbort = new Promise<void>(() => {});
        mocks.sessionAbort.mockReturnValueOnce(pendingAbort);
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const composer = renderer.root.findByType('MessageComposer');
        expect(composer.props.onAbort()).toBe(pendingAbort);
        expect(mocks.sessionAbort).toHaveBeenCalledWith('session-1');

        act(() => renderer.unmount());
    });

    it('opens a full-desktop screenshot directly without target or gallery state', async () => {
        mocks.isDataReady = true;
        mocks.requestScreenshot.mockResolvedValueOnce({
            success: true,
            dataBase64: 'AAA',
            mimeType: 'image/jpeg',
        });
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const composer = renderer.root.findByType('MessageComposer');
        await act(async () => {
            composer.props.onCaptureScreenshot();
            await Promise.resolve();
        });

        expect(mocks.requestScreenshot).toHaveBeenCalledWith('session-1');
        expect(mocks.imageViewerOpen).toHaveBeenCalledWith({
            uri: 'data:image/jpeg;base64,AAA',
            filename: expect.stringMatching(/^screenshot-\d+\.jpg$/),
        });

        act(() => renderer.unmount());
    });

    it('ignores repeated screenshot requests until the first capture settles', () => {
        mocks.isDataReady = true;
        mocks.requestScreenshot.mockReturnValueOnce(new Promise(() => {}));
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const composer = renderer.root.findByType('MessageComposer');
        act(() => {
            composer.props.onCaptureScreenshot();
            composer.props.onCaptureScreenshot();
        });

        expect(mocks.requestScreenshot).toHaveBeenCalledTimes(1);

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
        expect(renderer.root.findAllByProps({ testID: 'session-header-title' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-header-run-status' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('keeps the ordinary phone capability hub and omits Agent exit chrome', () => {
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Exit space' })).toHaveLength(0);
        expect(renderer.root.findByType('RightSwipePanelHost').props.panelAccessibilityLabel)
            .toBe('rightPanelCapabilityHub.title');

        act(() => renderer.unmount());
    });

    it('keeps the phone header focused on the current session and right-panel access', () => {
        mocks.isDataReady = true;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByType('SessionHeaderChip')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'session-header-title' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-header-run-status' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-header-more-button' })).toHaveLength(0);
        const panelToggle = renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' });
        expect(panelToggle.props['aria-expanded']).toBe(false);
        expect(renderer.root.findByType('RightSwipePanelHost').props.gestureEnabled).toBe(false);

        act(() => panelToggle.props.onPress());
        expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(true);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props['aria-expanded']).toBe(true);

        expect(renderer.root.findAllByProps({ testID: 'session-header-new-session-button' })).toHaveLength(0);
        expect(mocks.routerNavigate).not.toHaveBeenCalledWith('/new');

        act(() => renderer.unmount());
    });

    it('opens the public-session share dialog from the phone session chip', () => {
        mocks.isDataReady = true;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        act(() => renderer.root.findByType('SessionHeaderChip').props.onPress());
        const sessionInfo = renderer.root.findByType('SessionInfoDropdown');
        expect(sessionInfo.props.onShareSession).toEqual(expect.any(Function));

        act(() => sessionInfo.props.onShareSession());
        expect(mocks.modalShow).toHaveBeenCalledWith({
            accessibilityLabel: 'sessionShare.shareSession',
            component: 'PublicSessionShareDialog',
            props: {
                sessionId: 'session-1',
                title: 'Health session',
            },
        });
        expect(renderer.root.findAllByType('SessionInfoDropdown')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it.each([
        { isDataReady: false, sessionAvailable: true, windowWidth: 390, label: 'phone loading' },
        { isDataReady: true, sessionAvailable: false, windowWidth: 390, label: 'deleted phone session' },
        { isDataReady: false, sessionAvailable: true, windowWidth: 1100, label: 'wide loading' },
        { isDataReady: true, sessionAvailable: false, windowWidth: 1100, label: 'deleted wide session' },
    ])('disables every right drawer entry while $label is unavailable', ({ isDataReady, sessionAvailable, windowWidth }) => {
        mocks.isDataReady = isDataReady;
        mocks.sessionAvailable = sessionAvailable;
        mocks.windowWidth = windowWidth;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const host = renderer.root.findByType('RightSwipePanelHost');
        expect(host.props.enabled).toBe(false);
        expect(host.props.open).toBe(false);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel-toggle-button' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('uses the T14 header toggle to control a compact drawer at 1024px', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1024;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);
        const host = renderer.root.findByType('RightSwipePanelHost');
        expect(host.props.open).toBe(false);
        expect(renderer.root.findByType('ChatHeaderView').props.compactRightSlot).toBe(true);
        expect(renderer.root.findAllByType('SessionHeaderChip')).toHaveLength(0);
        expect(mocks.styleUseVariants).toHaveBeenCalledWith({ headerTitleDensity: 'compact' });
        const toggle = renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' });
        expect(toggle.props['aria-expanded']).toBe(false);

        act(() => toggle.props.onPress());
        expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(true);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props['aria-expanded']).toBe(true);
        expect(renderer.root.findAllByType('SessionHeaderChip')).toHaveLength(0);

        expect(mocks.globalRightSidebarShortcut).toEqual(expect.any(Function));
        act(() => mocks.globalRightSidebarShortcut?.());
        expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(false);
        expect(renderer.root.findByType('RightSwipePanelHost').props.showEdgeHandle).toBe(false);

        act(() => renderer.unmount());
    });

    it('blocks a closed compact drawer behind a visible dialog but still lets an open drawer close', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1024;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const visibleDialog = {
            getBoundingClientRect: () => ({ width: 320, height: 240 }),
        };
        let dialogs: unknown[] = [visibleDialog];
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { querySelectorAll: () => dialogs },
        });
        let renderer: any;

        try {
            act(() => {
                renderer = TestRenderer.create(<SessionView id="session-1" />);
            });

            act(() => mocks.globalRightSidebarShortcut?.());
            expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(false);

            dialogs = [];
            act(() => mocks.globalRightSidebarShortcut?.());
            expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(true);

            dialogs = [visibleDialog];
            act(() => mocks.globalRightSidebarShortcut?.());
            expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(false);
        } finally {
            if (renderer) act(() => renderer.unmount());
            if (originalDocument) {
                Object.defineProperty(globalThis, 'document', originalDocument);
            } else {
                Reflect.deleteProperty(globalThis, 'document');
            }
        }
    });

    it('restores the compact drawer entry after crossing both persistent breakpoints', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1099;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        mocks.desktopRightPanelCollapsed = true;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props['aria-expanded']).toBe(false);

        act(() => {
            mocks.windowWidth = 1100;
            renderer.update(<SessionView id="session-1" key="persistent-1100" />);
        });
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props['aria-expanded']).toBe(false);

        act(() => {
            mocks.windowWidth = 1099;
            renderer.update(<SessionView id="session-1" key="drawer-1099" />);
        });
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props['aria-expanded']).toBe(false);

        act(() => renderer.unmount());
    });

    it('falls back to a visible drawer toggle when a wide native tablet cannot host a persistent panel', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'android';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(1);
        expect(renderer.root.findByType('RightSwipePanelHost').props.mode).toBe('drawer-toggle');
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' })).toBeTruthy();

        act(() => renderer.unmount());
    });

    it('preserves the desktop file sidebar instead of mounting the swipe panel', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.runningOnMac = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);
        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(0);
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-content-transition' }).props).toMatchObject({
            direction: 'back',
            transitionKey: 'capabilities',
        });
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-capabilities-tab' }).props.dataSet).toMatchObject({
            happyMotion: 'desktop-tab',
            happyMotionState: 'selected',
        });

        const filesTab = renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' });
        expect(filesTab.props.accessibilityRole).toBe('tab');
        expect(filesTab.props.dataSet).toMatchObject({
            happyMotion: 'desktop-tab',
            happyMotionState: 'idle',
        });

        act(() => filesTab.props.onPress());
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-content-transition' }).props).toMatchObject({
            direction: 'forward',
            transitionKey: 'files',
        });
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-capabilities-tab' }).props.dataSet.happyMotionState).toBe('idle');
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.dataSet.happyMotionState).toBe('selected');
        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(1);
        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('animates file overlay history without remounting chat or accepting stale header cleanup', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const chatContent = renderer.root.findByType('MessageComposer');
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'forward',
            immediate: true,
            transitionKey: 'chat',
        });

        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
        let filesSidebar = renderer.root.findByType('FilesSidebar');
        act(() => filesSidebar.props.onFilePress({
            status: 'modified',
            fullPath: 'src/changed-motion.ts',
        }));
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'forward',
            immediate: false,
            transitionKey: 'diff:src/changed-motion.ts',
        });
        expect(renderer.root.findAllByProps({ testID: 'workspace-diff-panel' })).toHaveLength(1);
        expect(renderer.root.findByType('MessageComposer')).toBe(chatContent);

        const publishedAfterDiff = mocks.overlayPublish.mock.calls.at(-1)?.[0];
        act(() => publishedAfterDiff.back());
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'back',
            immediate: false,
            transitionKey: 'chat',
        });
        expect(renderer.root.findAllByProps({ testID: 'workspace-diff-panel' })).toHaveLength(0);
        expect(renderer.root.findByType('MessageComposer')).toBe(chatContent);

        const publishedAfterBack = mocks.overlayPublish.mock.calls.at(-1)?.[0];
        act(() => publishedAfterBack.forward());
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'forward',
            immediate: false,
            transitionKey: 'diff:src/changed-motion.ts',
        });

        filesSidebar = renderer.root.findByType('FilesSidebar');
        const oldDiffPublisher = renderer.root.findByType('AllFilesDiffView').props.onHeaderRightSlotChange;
        act(() => filesSidebar.props.onAllFilesFilePress('src/second-motion.ts'));
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'forward',
            immediate: false,
            transitionKey: 'file:src/second-motion.ts',
        });
        expect(renderer.root.findAllByProps({ testID: 'workspace-file-panel' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'workspace-diff-panel' })).toHaveLength(0);

        const filePublisher = renderer.root.findByType('FileViewPanel').props.onHeaderRightSlotChange;
        act(() => filePublisher('file-header-slot'));
        act(() => oldDiffPublisher('stale-diff-slot'));
        let header = renderer.root.findByType('ChatHeaderView');
        expect(header.findAll((node: any) => node.children.includes('file-header-slot'))).not.toHaveLength(0);
        expect(header.findAll((node: any) => node.children.includes('stale-diff-slot'))).toHaveLength(0);
        act(() => oldDiffPublisher(null));
        header = renderer.root.findByType('ChatHeaderView');
        expect(header.findAll((node: any) => node.children.includes('file-header-slot'))).not.toHaveLength(0);
        expect(renderer.root.findByType('MessageComposer')).toBe(chatContent);

        act(() => renderer.unmount());
    });

    it('immediately clears file overlays when the capability becomes unavailable', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
        const filesSidebar = renderer.root.findByType('FilesSidebar');
        act(() => filesSidebar.props.onFilePress({
            status: 'modified',
            fullPath: 'src/changed-motion.ts',
        }));
        expect(renderer.root.findAllByProps({ testID: 'workspace-diff-panel' })).toHaveLength(1);

        mocks.fileDiffsSidebarEnabled = false;
        act(() => filesSidebar.props.onModeChange('allFiles'));

        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
            direction: 'back',
            immediate: true,
            transitionKey: 'chat',
        });
        expect(renderer.root.findAllByProps({ testID: 'workspace-diff-panel' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'workspace-file-panel' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('changes overlay publisher ownership only after a suspended overlay commits', async () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        await act(async () => {
            renderer = TestRenderer.create(<SessionView id="session-1" />, {
                unstable_isConcurrent: true,
            } as any);
        });

        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
        const filesSidebar = renderer.root.findByType('FilesSidebar');
        act(() => filesSidebar.props.onFilePress({
            status: 'modified',
            fullPath: 'src/changed-motion.ts',
        }));
        const diffPublisher = renderer.root.findByType('AllFilesDiffView').props.onHeaderRightSlotChange;
        act(() => diffPublisher('committed-diff-slot'));

        let releaseFilePanel!: () => void;
        mocks.fileViewPanelSuspender = new Promise<void>((resolve) => {
            releaseFilePanel = resolve;
        });
        mocks.suspendFileViewPanel = true;
        act(() => {
            React.startTransition(() => {
                filesSidebar.props.onAllFilesFilePress('src/suspended-motion.ts');
            });
        });

        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props.transitionKey)
            .toBe('diff:src/changed-motion.ts');
        act(() => diffPublisher('still-current-diff-slot'));
        let header = renderer.root.findByType('ChatHeaderView');
        expect(header.findAll((node: any) => node.children.includes('still-current-diff-slot'))).not.toHaveLength(0);

        mocks.suspendFileViewPanel = false;
        await act(async () => {
            releaseFilePanel();
            await mocks.fileViewPanelSuspender;
        });
        expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props.transitionKey)
            .toBe('file:src/suspended-motion.ts');

        const filePublisher = renderer.root.findByType('FileViewPanel').props.onHeaderRightSlotChange;
        act(() => filePublisher('committed-file-slot'));
        act(() => diffPublisher('stale-after-file-commit'));
        header = renderer.root.findByType('ChatHeaderView');
        expect(header.findAll((node: any) => node.children.includes('committed-file-slot'))).not.toHaveLength(0);
        expect(header.findAll((node: any) => node.children.includes('stale-after-file-commit'))).toHaveLength(0);

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

        const expectedInset = getPersistentHeaderContentInset({
            windowWidth: mocks.windowWidth,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            sidebarVisible: true,
            rightPanelWidth: getDesktopRightPanelWidth(mocks.windowWidth),
            controlStartPadding: 16,
            buttonCount: 4,
            controlsWidth: PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
            targetHitSlop: 8,
        });
        expect(renderer.root.findByType('ChatHeaderView').props.headerContentLeftInset).toBe(expectedInset);

        act(() => renderer.unmount());
    });

    it('shows the capability hub by default on a wide desktop session', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel' }).props.style).toContainEqual(
            expect.objectContaining({ borderLeftWidth: 0 }),
        );
        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);
        expect(renderer.root.findAllByType('RightSwipePanelHost')).toHaveLength(0);
        expect(renderer.root.findByType('ChatHeaderView').props.compactRightSlot).toBe(false);

        act(() => renderer.unmount());
    });

    it('opens the subagent inspector in the compact drawer and returns to capabilities', () => {
        mocks.isDataReady = true;
        mocks.sessionMessages = [{
            kind: 'agent-text',
            id: 'message-one',
            localId: null,
            createdAt: 1,
            text: 'Visible message',
        }];
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        expect(renderer.root.findByType('RightSwipePanelHost').props.open).toBe(false);

        expect(mocks.openSubagent).toEqual(expect.any(Function));
        act(() => mocks.openSubagent?.({
            id: 'agent-one',
            title: 'Implementation agent',
            status: 'running',
        }));

        expect(renderer.root.findByType('RightSwipePanelHost').props).toMatchObject({
            fullWidth: true,
            open: true,
        });
        const inspectorPanel = renderer.root.findByType('SubagentInspectorPanel');
        expect(inspectorPanel.props.selection.id).toBe('agent-one');
        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(0);

        act(() => inspectorPanel.props.onBack());
        expect(renderer.root.findByType('RightSwipePanelHost').props).toMatchObject({
            fullWidth: false,
            open: true,
        });
        expect(renderer.root.findAllByType('SubagentInspectorPanel')).toHaveLength(0);
        expect(renderer.root.findAllByType('SessionCapabilityHub')).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('temporarily replaces the desktop Files panel and restores it on inspector back', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        mocks.sessionMessages = [{
            kind: 'agent-text',
            id: 'message-one',
            localId: null,
            createdAt: 1,
            text: 'Visible message',
        }];
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(1);

        expect(mocks.openSubagent).toEqual(expect.any(Function));
        act(() => mocks.openSubagent?.({
            id: 'agent-one',
            title: 'Implementation agent',
            status: 'completed',
        }));

        expect(mocks.setDesktopRightPanelCollapsed).toHaveBeenCalledWith(false);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(0);
        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(0);
        const inspectorPanel = renderer.root.findByType('SubagentInspectorPanel');

        act(() => inspectorPanel.props.onBack());
        expect(renderer.root.findAllByType('SubagentInspectorPanel')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel' })).toHaveLength(1);
        expect(renderer.root.findAllByType('FilesSidebar')).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('collapses and restores the desktop capability panel independently', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        expect(renderer.root.findAllByProps({ testID: 'desktop-right-panel-collapse-button' })).toHaveLength(0);
        const toggle = renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' });
        expect(toggle.props['aria-expanded']).toBe(true);
        expect(renderer.root.findByProps({ testID: 'desktop-right-panel-motion' }).props.dataSet).toMatchObject({
            happyMotion: 'desktop-panel',
            happyMotionSide: 'right',
            happyMotionState: 'open',
        });
        act(() => toggle.props.onPress());
        expect(mocks.setDesktopRightPanelCollapsed).toHaveBeenCalledWith(true);

        act(() => {
            renderer.unmount();
            mocks.desktopRightPanelCollapsed = true;
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        const collapsedToggle = renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' });
        expect(collapsedToggle.props['aria-expanded']).toBe(false);
        const collapsedPanelMotion = renderer.root.findByProps({ testID: 'desktop-right-panel-motion' });
        expect(collapsedPanelMotion.parent?.props.inert).toBe(true);
        expect(collapsedPanelMotion.props.dataSet).toMatchObject({
            happyMotion: 'desktop-panel',
            happyMotionSide: 'right',
            happyMotionState: 'closed',
        });
        act(() => collapsedToggle.props.onPress());
        expect(mocks.setDesktopRightPanelCollapsed).toHaveBeenLastCalledWith(false);

        act(() => renderer.unmount());
    });

    it('keeps the unified right-panel toggle available while a file overlay is open', () => {
        mocks.isDataReady = true;
        mocks.fileDiffsSidebarEnabled = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
        const filesSidebar = renderer.root.findByType('FilesSidebar');
        act(() => filesSidebar.props.onFilePress({
            status: 'modified',
            fullPath: '/tmp/example.ts',
        }));
        act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' }).props.onPress());

        act(() => {
            mocks.desktopRightPanelCollapsed = true;
            filesSidebar.props.onModeChange('allFiles');
        });

        const toggle = renderer.root.findByProps({ testID: 'desktop-right-panel-toggle-button' });
        expect(toggle.props.accessibilityLabel).toBe('desktopWorkspace.showPanel');
        act(() => toggle.props.onPress());
        expect(mocks.setDesktopRightPanelCollapsed).toHaveBeenLastCalledWith(false);

        act(() => renderer.unmount());
    });

    it('edits the desktop title inline while keeping status and the More menu', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findAllByProps({ testID: 'session-header-new-session-button' })).toHaveLength(0);
        expect(renderer.root.findAllByType('SessionHeaderChip')).toHaveLength(0);

        const title = renderer.root.findByProps({ testID: 'session-header-title' });
        expect(title.props.accessibilityRole).toBe('button');
        expect(title.props.accessibilityLabel).toBe(
            `sessionInfo.renameSession: ${renderer.root.findByType('ChatHeaderView').props.title}`,
        );
        expect(title.props.style).toMatchObject({ minHeight: 40, overflow: 'hidden' });
        expect(renderer.root.findAllByProps({ testID: 'session-header-title-edit-icon' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'session-header-run-status' }).props.accessibilityLabel).toBe('Online');
        expect(title.parent.props.style).not.toMatchObject({ overflow: 'hidden' });
        expect(title.props.onFocus).toBeUndefined();
        expect(title.props.onHoverIn).toBeUndefined();
        expect(renderer.root.findAllByProps({ testID: 'session-header-title-tooltip' })).toHaveLength(0);
        const tagsButton = renderer.root.findByProps({ testID: 'session-header-tags-button' });
        expect(tagsButton.findByType('Text').props.children).toBe('#');
        act(() => tagsButton.props.onPress());
        const tagInput = renderer.root.findByProps({ testID: 'session-header-title-input' });
        expect(tagInput.props.value).toBe('Health session #');
        expect(renderer.root.findByProps({ testID: 'session-title-tag-results' }).props.role).toBe('listbox');
        expect(renderer.root.findByProps({ testID: 'session-title-tag-result-product' }).props.role).toBe('option');
        act(() => tagInput.props.onSubmitEditing());
        expect(renderer.root.findByProps({ testID: 'session-header-title-input' }).props.value).toBe('Health session');
        expect(mocks.updateSidebarOrganization).toHaveBeenCalledTimes(1);

        act(() => renderer.root.findByProps({ testID: 'session-header-title-input' }).props.onSubmitEditing());
        expect(mocks.renameSessionToTitle).toHaveBeenCalledWith('Health session');
        expect(renderer.root.findByProps({ testID: 'session-canvas-tag-product' }).findByType('Text').props.children.join('')).toBe('#product');

        act(() => renderer.root.findByProps({ testID: 'session-header-title' }).props.onPress());
        const titleInput = renderer.root.findByProps({ testID: 'session-header-title-input' });
        act(() => titleInput.props.onChangeText('Renamed inline'));
        act(() => titleInput.props.onSubmitEditing());
        expect(mocks.renameSessionToTitle).toHaveBeenCalledWith('Renamed inline');

        const updatedTitle = renderer.root.findByProps({ testID: 'session-header-title' });
        act(() => updatedTitle.props.onPress());
        const cancelledTitleInput = renderer.root.findByProps({ testID: 'session-header-title-input' });
        act(() => cancelledTitleInput.props.onChangeText('Cancelled rename'));
        act(() => cancelledTitleInput.props.onKeyPress({ nativeEvent: { key: 'Escape' } }));
        expect(mocks.renameSessionToTitle).toHaveBeenCalledTimes(2);

        act(() => renderer.root.findByProps({ testID: 'session-header-title' }).props.onPress());
        const createInput = renderer.root.findByProps({ testID: 'session-header-title-input' });
        act(() => createInput.props.onChangeText('Health session #fresh'));
        expect(renderer.root.findByProps({ testID: 'session-title-create-tag' }).props.role).toBe('option');
        act(() => renderer.root.findByProps({ testID: 'session-header-title-input' }).props.onSubmitEditing());
        expect(renderer.root.findByProps({ testID: 'session-header-title-input' }).props.value).toBe('Health session');
        const updater = mocks.updateSidebarOrganization.mock.calls.at(-1)?.[0];
        const updatedOrganization = updater({
            lists: [],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: null, tagIds: ['product'] } },
        });
        expect(updatedOrganization.tags.map((tag: { name: string }) => tag.name)).toContain('fresh');

        act(() => renderer.root.findByProps({ testID: 'session-canvas-add-tag' }).props.onPress());
        expect(renderer.root.findByType('SessionOrganizerDialog').props.visible).toBe(true);

        const more = renderer.root.findByProps({ testID: 'session-header-more-button' });
        expect(more.props.accessibilityLabel).toBe('sessionInfo.viewDetails');
        expect(more.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ width: 40, height: 40 }));
        expect(renderer.root.findAllByProps({ testID: 'session-header-more-tooltip' })).toHaveLength(0);
        act(() => more.props.onPress());
        expect(renderer.root.findAllByType('SessionInfoDropdown')).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('reveals a desktop canvas Tag remove button on hover and only unassigns it from the session', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        const tag = renderer.root.findByProps({ testID: 'session-canvas-tag-product' });
        const remove = renderer.root.findByProps({ testID: 'session-canvas-remove-tag-product' });
        expect(remove.props.accessibilityLabel).toBe('common.delete #product');
        expect(remove.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ opacity: 0, width: 0 }));

        act(() => tag.props.onHoverIn());
        const hoveredRemove = renderer.root.findByProps({ testID: 'session-canvas-remove-tag-product' });
        expect(hoveredRemove.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ opacity: 1, width: 22 }));

        act(() => {
            tag.props.onHoverOut();
            hoveredRemove.props.onFocus();
        });
        const focusedRemove = renderer.root.findByProps({ testID: 'session-canvas-remove-tag-product' });
        expect(focusedRemove.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ opacity: 1, width: 22 }));

        act(() => focusedRemove.props.onPress());
        expect(renderer.root.findByType('SessionOrganizerDialog').props.visible).toBe(false);
        expect(mocks.updateSidebarOrganization).toHaveBeenCalledTimes(1);
        const updater = mocks.updateSidebarOrganization.mock.calls[0]?.[0];
        const current = {
            lists: [{
                id: 'list-1',
                name: 'Happy',
                kind: 'agent',
                color: 'green',
                createdAt: 1,
            }],
            tags: [
                { id: 'product', name: 'product', color: 'green', createdAt: 1 },
                { id: 'research', name: 'research', color: 'blue', createdAt: 2 },
            ],
            sessions: { 'session-1': { listId: 'list-1', tagIds: ['product', 'research'] } },
        } as any;
        const updated = updater(current);
        expect(updated.tags).toEqual(current.tags);
        expect(updated.sessions['session-1']).toEqual({ listId: 'list-1', tagIds: ['research'] });

        act(() => tag.props.onPress());
        expect(renderer.root.findByType('SessionOrganizerDialog').props.visible).toBe(true);

        act(() => renderer.unmount());
    });

    it('keeps unselected title Tag options disabled when the session reaches its limit', () => {
        mocks.isDataReady = true;
        mocks.windowWidth = 1400;
        mocks.isTablet = true;
        mocks.platformOS = 'web';
        const tags = Array.from({ length: 101 }, (_, index) => ({
            id: `tag-${index}`,
            name: `tag-${index}`,
            color: 'green',
            createdAt: index,
        }));
        mocks.sidebarOrganization = {
            lists: [],
            tags,
            sessions: { 'session-1': { listId: null, tagIds: tags.slice(0, 100).map((tag) => tag.id) } },
        };
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });
        act(() => renderer.root.findByProps({ testID: 'session-header-tags-button' }).props.onPress());
        const input = renderer.root.findByProps({ testID: 'session-header-title-input' });
        act(() => input.props.onChangeText('Health session #tag-100'));
        const blockedOption = renderer.root.findByProps({ testID: 'session-title-tag-result-tag-100' });
        expect(blockedOption.props.disabled).toBe(true);
        expect(blockedOption.props['aria-disabled']).toBe(true);
        act(() => renderer.root.findByProps({ testID: 'session-header-title-input' }).props.onSubmitEditing());
        expect(renderer.root.findByProps({ testID: 'session-header-title-input' }).props.value).toBe('Health session #tag-100');

        act(() => input.props.onChangeText('Health session #missing'));
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'sidebarLists.tagLimitReached')).toBe(true);
        act(() => renderer.unmount());
    });

    it.each([
        { windowWidth: 1100, compact: true },
        { windowWidth: 1179, compact: true },
        { windowWidth: 1180, compact: false },
        { windowWidth: 1280, compact: false },
    ])('keeps the native tablet metadata chip compact=$compact at $windowWidth px', ({ windowWidth, compact }) => {
        mocks.isDataReady = true;
        mocks.isTablet = true;
        mocks.platformOS = 'android';
        mocks.windowWidth = windowWidth;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SessionView id="session-1" />);
        });

        expect(renderer.root.findByType('SessionHeaderChip').props.compact).toBe(compact);
        expect(mocks.styleUseVariants).toHaveBeenCalledWith({
            agentChipDensity: 'regular',
            headerDensity: compact ? 'compact' : 'regular',
        });
        expect(mocks.styleUseVariants).toHaveBeenCalledWith({
            headerTitleDensity: compact ? 'compact' : 'regular',
        });

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
