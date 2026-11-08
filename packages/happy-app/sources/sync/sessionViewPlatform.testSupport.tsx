import * as React from 'react';
import { vi } from 'vitest';

// Platform and unrelated SessionView children only. Sync, storage, Deferred and
// the verified-message consumer remain real in the local-history composition.
vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    FlatList: 'FlatList',
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
    FadeIn: { duration: () => undefined }, FadeOut: { duration: () => undefined },
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
            accent: '#777', divider: '#444', groupped: { background: '#111' }, fab: { background: '#fff' },
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
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-application', () => ({ applicationId: 'build.paws.preview' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ dispatch: vi.fn() }),
    useRouter: () => ({ back: vi.fn(), navigate: vi.fn(), push: vi.fn() }),
}));
vi.mock('@react-navigation/native', () => ({ DrawerActions: { openDrawer: () => ({ type: 'OPEN' }) }, useIsFocused: () => true }));
vi.mock('@/sync/screenshotGallery', () => ({
    addScreenshotEntry: vi.fn(), saveBase64Png: vi.fn(), useHasNewScreenshots: () => ({ hasNew: false }),
}));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/utils/responsive', () => ({
    useDeviceType: () => 'phone', useHeaderHeight: () => 52, useIsLandscape: () => false, useIsTablet: () => false,
}));
vi.mock('@/utils/desktopNavigationLayout', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/desktopNavigationLayout')>(),
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
vi.mock('@/utils/sessionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessionUtils')>(),
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
vi.mock('@/components/EmptyMessages', () => ({ EmptyMessages: 'EmptyMessages' }));
vi.mock('@/components/FilesSidebar', () => ({ FilesSidebar: 'FilesSidebar' }));
vi.mock('@/components/AllFilesDiffView', () => ({ AllFilesDiffView: 'AllFilesDiffView' }));
vi.mock('@/components/FileViewPanel', () => ({ FileViewPanel: 'FileViewPanel' }));
// This phone transcript harness does not host the PC workspace. Its real file
// owner and editor lifecycle are exercised by fileWorkspace's integration tests.
vi.mock('@/components/fileWorkspace/SessionFileWorkspaceProvider', () => ({
    SessionFileWorkspaceProvider: ({children}: {children: React.ReactNode}) => React.createElement(React.Fragment, {}, children),
}));
vi.mock('@/components/fileWorkspace/FileWorkspace', () => ({ FileWorkspace: () => null, FileWorkspaceResizeHandle: () => null }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => null }));
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
