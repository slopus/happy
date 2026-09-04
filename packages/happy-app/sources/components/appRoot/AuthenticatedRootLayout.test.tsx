import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

vi.stubGlobal('__DEV__', false);

vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Platform: { OS: 'web' },
    View: 'View',
}));
vi.mock('expo-splash-screen', () => ({
    hideAsync: vi.fn().mockResolvedValue(undefined),
    preventAutoHideAsync: vi.fn().mockResolvedValue(undefined),
    setOptions: vi.fn(),
}));
vi.mock('expo-notifications', () => ({
    AndroidImportance: { HIGH: 4, MAX: 5 },
    DEFAULT_ACTION_IDENTIFIER: 'default',
    addNotificationResponseReceivedListener: () => ({ remove: vi.fn() }),
    clearLastNotificationResponseAsync: vi.fn().mockResolvedValue(undefined),
    getLastNotificationResponseAsync: vi.fn().mockResolvedValue(null),
    setNotificationChannelAsync: vi.fn().mockResolvedValue(undefined),
    setNotificationHandler: vi.fn(),
}));
vi.mock('expo-application', () => ({ applicationId: 'build.paws' }));
vi.mock('expo-updates', () => ({ channel: 'production' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@react-navigation/native', () => ({
    DarkTheme: { colors: {} },
    DefaultTheme: { colors: {} },
    ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('posthog-react-native', () => ({
    PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { groupped: { background: '#fff' } }, dark: false } }),
}));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn().mockResolvedValue(null),
        setCredentials: vi.fn().mockResolvedValue(true),
    },
}));
vi.mock('@/auth/AuthContext', () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/SidebarNavigator', () => ({ SidebarNavigator: 'SidebarNavigator' }));
vi.mock('@/components/DesktopSettingsModal', async () => {
    const { useUnifiedAuthQrCode } = await vi.importActual<typeof import('@/hooks/useUnifiedAuthQrCode')>(
        '@/hooks/useUnifiedAuthQrCode',
    );
    return {
        DesktopSettingsModalProvider: ({ children }: { children: React.ReactNode }) => {
            useUnifiedAuthQrCode();
            return children;
        },
    };
});
vi.mock('@/components/ThemeTransition', () => ({
    ThemeCaptureRoot: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { ready: Promise.resolve() } }));
vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
    },
    ModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/track/tracking', () => ({ tracking: null }));
vi.mock('@/sync/sync', () => ({ syncRestore: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/track/useTrackScreens', () => ({ useTrackScreens: vi.fn() }));
vi.mock('@/realtime/RealtimeProvider', () => ({
    RealtimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/web/FaviconPermissionIndicator', () => ({ FaviconPermissionIndicator: () => null }));
vi.mock('@/components/notifications/AndroidAppIconBadge', () => ({ AndroidAppIconBadge: () => null }));
vi.mock('@/components/CommandPalette/CommandPaletteProvider', () => ({
    CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ImageViewerHost', () => ({ ImageViewerHost: () => null }));
vi.mock('@/components/StatusBarProvider', () => ({ StatusBarProvider: () => null }));
vi.mock('@/utils/consoleLogging', () => ({
    initConsoleLogging: vi.fn(),
    setConsoleOutputEnabled: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({ useLocalSetting: vi.fn().mockReturnValue(false) }));
vi.mock('@/utils/notificationRouting', () => ({
    getPublicSessionShareRetrySessionId: vi.fn().mockReturnValue(null),
    getSessionRouteFromNotificationResponse: vi.fn().mockReturnValue(null),
}));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: vi.fn() }));
vi.mock('@/realtime/voiceExperiment', () => ({ applyVoiceUpsellOverride: vi.fn() }));
vi.mock('@/hooks/useTauriZoom', () => ({ useTauriZoom: vi.fn() }));
vi.mock('@/hooks/useTauriDrag', () => ({ useTauriDrag: vi.fn() }));
vi.mock('@/hooks/useBrowserNavigationShortcuts', () => ({ BrowserNavigationShortcuts: () => null }));
vi.mock('@/components/OtaPreviewFloatingButton', () => ({ OtaPreviewFloatingButton: () => null }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({ otaChannel: 'production' }) }));
vi.mock('@/utils/otaFloatingSwitcher', () => ({ shouldShowOtaFloatingSwitcher: () => false }));
vi.mock('./appRootFonts', () => ({ loadAppRootFonts: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/PublicSessionShareJobResumer', () => ({ PublicSessionShareJobResumer: () => null }));
vi.mock('@/sync/publicSessionShareQueueRuntime', () => ({ retryPublicSessionShareJob: vi.fn() }));
vi.mock('@/hooks/useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('@/hooks/useConnectAccount', () => ({
    useConnectAccount: () => ({ isLoading: false, processAuthUrl: vi.fn().mockResolvedValue(true) }),
}));
vi.mock('@/hooks/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ isLoading: false, processAuthUrl: vi.fn().mockResolvedValue(true) }),
}));
vi.mock('expo-camera', () => ({
    CameraView: {
        dismissScanner: vi.fn().mockResolvedValue(undefined),
        isModernBarcodeScannerAvailable: true,
        launchScanner: vi.fn().mockResolvedValue(undefined),
        onModernBarcodeScanned: () => ({ remove: vi.fn() }),
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import AuthenticatedRootLayout from './AuthenticatedRootLayout';

describe('AuthenticatedRootLayout scanner provider topology', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
    });

    it('keeps the desktop settings surface inside the unified scanner provider', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<AuthenticatedRootLayout />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(renderer!.toJSON()).not.toBeNull();
    });
});
