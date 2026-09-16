import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

const bootStages = vi.hoisted(() => {
    const stages: string[] = [];
    (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
        initFreshDeepLink: () => stages.push('web.root.module_ready'),
        markAppStage: (stage: string) => stages.push(stage),
        markFreshHeaderVisible: () => stages.push('web.route.mounted'),
    };
    return stages;
});

const accountMocks = vi.hoisted(() => ({
    migrateLegacyAccount: vi.fn(async () => undefined),
    recoverAccountSelection: vi.fn(async (_generation?: string) => undefined),
    freezeAccountRuntime: vi.fn(),
    reload: vi.fn(async () => undefined),
    replace: vi.fn(),
    indexSet: vi.fn(),
}));

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
vi.mock('expo-updates', () => ({ channel: 'production', reloadAsync: accountMocks.reload }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/auth/accounts', () => ({ migrateLegacyAccount: accountMocks.migrateLegacyAccount, recoverAccountSelection: accountMocks.recoverAccountSelection }));
vi.mock('@/auth/accountRuntime', () => ({
    accountIndex: { getString: vi.fn(), delete: vi.fn(), set: accountMocks.indexSet },
    getActiveAccountKey: () => null,
    getRuntimeAccountSelection: () => ({ generation: 'generation-A' }),
    freezeAccountRuntime: accountMocks.freezeAccountRuntime,
}));
vi.mock('@/auth/accountNetwork', () => ({ installAccountNetworkGuard: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
vi.mock('@/components/accounts/AccountTransitionScreen', () => ({ AccountTransitionScreen: 'AccountTransitionScreen' }));
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
import { loadAppRootFonts } from './appRootFonts';
import { TokenStorage } from '@/auth/tokenStorage';
import { syncRestore } from '@/sync/sync';
import { Platform } from 'react-native';

describe('AuthenticatedRootLayout scanner provider topology', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadAppRootFonts).mockResolvedValue(undefined);
        vi.mocked(TokenStorage.getCredentials).mockResolvedValue(null);
        vi.mocked(syncRestore).mockClear();
        Platform.OS = 'web';
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it.each(['web', 'ios'] as const)('keeps pending fonts off the Web boot path while retaining the %s prerequisite', async (platform) => {
        Platform.OS = platform;
        let finishFonts!: () => void;
        vi.mocked(loadAppRootFonts).mockReturnValue(new Promise(resolve => { finishFonts = resolve; }));
        const credentials = { token: 'restored-token', secret: 'restored-secret' };
        vi.mocked(TokenStorage.getCredentials).mockResolvedValue(credentials);
        await act(async () => { renderer = TestRenderer.create(<AuthenticatedRootLayout />); });
        if (platform === 'web') {
            expect(renderer!.toJSON()).not.toBeNull();
            expect(syncRestore).toHaveBeenCalledWith(credentials);
        } else {
            expect(renderer!.toJSON()).toBeNull();
            expect(syncRestore).not.toHaveBeenCalled();
        }
        await act(async () => { finishFonts(); });
        expect(renderer!.toJSON()).not.toBeNull();
        expect(syncRestore).toHaveBeenCalledWith(credentials);
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
        vi.unstubAllGlobals();
        vi.stubGlobal('__DEV__', false);
    });

    it.each(['web', 'ios'] as const)('recovers a broken credential selection and opens account management on %s', async (platform) => {
        Platform.OS = platform;
        vi.stubGlobal('window', { location: { replace: accountMocks.replace } });
        vi.mocked(TokenStorage.getCredentials).mockRejectedValueOnce(new Error('damaged credentials'));
        await act(async () => { renderer = TestRenderer.create(<AuthenticatedRootLayout />); });
        const transition = renderer!.root.findByType('AccountTransitionScreen');
        expect(transition.props.error).toBe(true);
        expect(syncRestore).not.toHaveBeenCalled();
        await act(async () => { transition.props.onCancel(); });
        expect(accountMocks.freezeAccountRuntime).toHaveBeenCalledOnce();
        expect(accountMocks.recoverAccountSelection).toHaveBeenCalledWith('generation-A');
        expect(accountMocks.migrateLegacyAccount).not.toHaveBeenCalled();
        if (platform === 'web') {
            expect(accountMocks.replace).toHaveBeenCalledWith('/accounts');
            expect(accountMocks.reload).not.toHaveBeenCalled();
        } else {
            expect(accountMocks.indexSet).toHaveBeenCalledWith('pending-route', JSON.stringify({ key: null, path: '/accounts' }));
            expect(accountMocks.reload).toHaveBeenCalledOnce();
            expect(accountMocks.replace).not.toHaveBeenCalled();
        }
    });

    it('keeps the desktop settings surface inside the unified scanner provider', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<AuthenticatedRootLayout />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(renderer!.toJSON()).not.toBeNull();
    });

    it('publishes boot prerequisites without claiming the target session route has mounted', async () => {
        // Catches boot attribution reporting a downstream render milestone before its prerequisite is ready.
        const start = bootStages.length;
        await act(async () => {
            renderer = TestRenderer.create(<AuthenticatedRootLayout />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(bootStages.slice(start)).toEqual([
            'web.crypto.ready',
            'web.credentials.ready',
        ]);
    });
});
