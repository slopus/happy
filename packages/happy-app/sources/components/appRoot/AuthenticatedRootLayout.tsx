import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { useRouter } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, Platform, AppState } from 'react-native';
import { PostHogProvider } from 'posthog-react-native';
import { useUnistyles } from 'react-native-unistyles';
import { AuthCredentials, TokenStorage } from '@/auth/tokenStorage';
import { AuthProvider } from '@/auth/AuthContext';
import { migrateLegacyAccount, recoverAccountSelection } from '@/auth/accounts';
import { accountIndex, getActiveAccountKey, getRuntimeAccountSelection, freezeAccountRuntime } from '@/auth/accountRuntime';
import { installAccountNetworkGuard } from '@/auth/accountNetwork';
import { AccountTransitionScreen } from '@/components/accounts/AccountTransitionScreen';
import { getServerUrl } from '@/sync/serverConfig';
import { SidebarNavigator } from '@/components/SidebarNavigator';
import { DesktopSettingsModalProvider } from '@/components/DesktopSettingsModal';
import { ThemeCaptureRoot } from '@/components/ThemeTransition';
import sodium from '@/encryption/libsodium.lib';
import { ModalProvider } from '@/modal';
import { tracking } from '@/track/tracking';
import { syncRestore } from '@/sync/sync';
import { useTrackScreens } from '@/track/useTrackScreens';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { AndroidAppIconBadge } from '@/components/notifications/AndroidAppIconBadge';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { ImageViewerHost } from '@/components/ImageViewerHost';
import { StatusBarProvider } from '@/components/StatusBarProvider';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/sync/storage';
import { getPublicSessionShareRetrySessionId, getSessionRouteFromNotificationResponse } from '@/utils/notificationRouting';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { applyVoiceUpsellOverride } from '@/realtime/voiceExperiment';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { useTauriDrag } from '@/hooks/useTauriDrag';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';
import { OtaPreviewFloatingButton } from '@/components/OtaPreviewFloatingButton';
import { loadAppConfig } from '@/sync/appConfig';
import { shouldShowOtaFloatingSwitcher } from '@/utils/otaFloatingSwitcher';
import { loadAppRootFonts } from './appRootFonts';
import { shouldPresentNotification } from '@/utils/notificationPresentation';
import { PublicSessionShareJobResumer } from '@/components/PublicSessionShareJobResumer';
import { retryPublicSessionShareJob } from '@/sync/publicSessionShareQueueRuntime';
import { UnifiedAuthQrCodeProvider } from '@/hooks/useUnifiedAuthQrCode';
import { markSessionCriticalPathAppStage } from '@/sync/sessionCriticalPathProbeBridge';

Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const kind = (notification?.request?.content?.data as { kind?: unknown } | undefined)?.kind;
        const shouldShow = shouldPresentNotification(kind, AppState.currentState);
        return {
            shouldShowAlert: shouldShow,
            shouldPlaySound: shouldShow,
            shouldSetBadge: true,
            shouldShowBanner: shouldShow,
            shouldShowList: true,
        };
    },
});

if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        showBadge: true,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
    void Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        showBadge: true,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
}

initConsoleLogging();
installAccountNetworkGuard();
markSessionCriticalPathAppStage('web.root.module_ready');

function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return <View style={{ flex: 1, paddingLeft: insets.left, paddingRight: insets.right }}>{children}</View>;
}

function stringifyNotificationPayload(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch (error) {
        return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
}

function getDevEnvironmentCredentials(): AuthCredentials | null {
    if (!__DEV__) return null;
    const token = process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = process.env.EXPO_PUBLIC_DEV_SECRET;
    return token && secret ? { token, secret } : null;
}

function getDevWebQueryCredentials(): AuthCredentials | null {
    if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token');
    const secret = params.get('dev_secret');
    return token && secret ? { token, secret } : null;
}

function usePawsNavigationTheme() {
    const { theme } = useUnistyles();
    return React.useMemo(() => {
        const base = theme.dark ? DarkTheme : DefaultTheme;
        return {
            ...base,
            colors: { ...base.colors, background: theme.colors.groupped.background },
        };
    }, [theme.colors.groupped.background, theme.dark]);
}

export default function AuthenticatedRootLayout() {
    useTauriZoom();
    useTauriDrag();
    const router = useRouter();
    const navigationTheme = usePawsNavigationTheme();
    const appConfig = React.useMemo(() => loadAppConfig(), []);
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');
    const showOtaFloatingSwitcher = shouldShowOtaFloatingSwitcher({
        platform: Platform.OS,
        appConfigChannel: appConfig.otaChannel,
        updatesChannel: Updates.channel,
        applicationId: Application.applicationId,
        isDev: __DEV__,
        devModeEnabled,
    });
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    const [initError, setInitError] = React.useState(false);

    React.useEffect(() => {
        void (async () => {
            try {
                const fonts = loadAppRootFonts();
                if (Platform.OS === 'web') {
                    void fonts.catch(error => console.log('[fonts] Background loading failed; using fallback fonts.', error));
                } else {
                    await fonts;
                }
                await sodium.ready;
                markSessionCriticalPathAppStage('web.crypto.ready');
                let credentials = await TokenStorage.getCredentials();
                const devCredentials = getDevWebQueryCredentials() ?? getDevEnvironmentCredentials();
                if (devCredentials) {
                    const changed = credentials?.token !== devCredentials.token || credentials?.secret !== devCredentials.secret;
                    if (changed && await TokenStorage.setCredentials(devCredentials)) credentials = devCredentials;
                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                }
                markSessionCriticalPathAppStage('web.credentials.ready');
                if (credentials) {
                    await migrateLegacyAccount(credentials);
                    await syncRestore(credentials);
                }
                setInitState({ credentials });
            } catch (error) {
                setInitError(true);
                void SplashScreen.hideAsync();
            }
        })();
    }, []);

    React.useEffect(() => {
        if (!initState) return;
        const pending = accountIndex.getString('pending-route');
        if (pending) {
            accountIndex.delete('pending-route');
            try {
                const target = JSON.parse(pending);
                if (target.key === getActiveAccountKey() && (target.path === '/accounts' || /^\/session\/[a-zA-Z0-9_-]{1,128}$/.test(target.path))) router.replace(target.path);
            } catch { /* A damaged pending route does not block startup. */ }
        }
        const timer = setTimeout(() => { void SplashScreen.hideAsync(); }, 100);
        return () => clearTimeout(timer);
    }, [initState]);

    const handledNotificationIds = React.useRef<Set<string>>(new Set());
    const handleNotificationResponse = React.useCallback(async (response: Notifications.NotificationResponse | null) => {
        if (!response) return;
        console.log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));
        const responseId = response.notification.request.identifier;
        if (handledNotificationIds.current.has(responseId)) return;
        handledNotificationIds.current.add(responseId);
        try {
            if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
            const route = getSessionRouteFromNotificationResponse(response);
            if (!route) return;
            const encodedSessionId = route.replace(/^\/session\//, '');
            let sessionId = encodedSessionId;
            try { sessionId = decodeURIComponent(encodedSessionId); } catch { /* Keep the encoded identifier. */ }
            // Old notifications can remain on a device after switching accounts.
            const credentials = await TokenStorage.getCredentials();
            if (!credentials) return;
            const ownership = await fetch(`${getServerUrl()}/v2/sessions/${encodeURIComponent(sessionId)}`, {
                headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(10000),
            });
            if (!ownership.ok) return;
            const retrySessionId = getPublicSessionShareRetrySessionId(response);
            if (retrySessionId === sessionId) retryPublicSessionShareJob(retrySessionId);
            navigateToSession(router, sessionId);
        } catch {
            // A stale or inaccessible notification does not change accounts.
        } finally {
            await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
        }
    }, [router]);

    React.useEffect(() => {
        if (!initState) return;
        let active = true;
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            void handleNotificationResponse(response);
        });
        void Notifications.getLastNotificationResponseAsync()
            .then(async (response) => {
                if (active) await handleNotificationResponse(response);
            })
            .catch(() => undefined);
        return () => {
            active = false;
            subscription.remove();
        };
    }, [handleNotificationResponse, initState]);

    useTrackScreens();
    const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
    const voiceUpsellOverride = useLocalSetting('voiceUpsellOverride');
    React.useEffect(() => setConsoleOutputEnabled(consoleLoggingEnabled), [consoleLoggingEnabled]);
    React.useEffect(() => {
        if (devModeEnabled && voiceUpsellOverride) applyVoiceUpsellOverride(voiceUpsellOverride);
    }, [devModeEnabled, voiceUpsellOverride]);

    if (initError) return <AccountTransitionScreen error onCancel={() => void (async () => {
        freezeAccountRuntime();
        await recoverAccountSelection(getRuntimeAccountSelection()?.generation);
        if (Platform.OS === 'web') window.location.replace('/accounts');
        else {
            accountIndex.set('pending-route', JSON.stringify({ key: getActiveAccountKey(), path: '/accounts' }));
            await Updates.reloadAsync();
        }
    })().catch(() => undefined)} onRetry={() => {
        if (Platform.OS === 'web') window.location.reload();
        else void Updates.reloadAsync().catch(() => undefined);
    }} />;
    if (!initState) return null;

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider preload={false}>
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <ThemeCaptureRoot>
                        <AuthProvider initialCredentials={initState.credentials}>
                            <ThemeProvider value={navigationTheme}>
                                <StatusBarProvider />
                                <ModalProvider>
                                    <UnifiedAuthQrCodeProvider>
                                        <DesktopSettingsModalProvider>
                                            <BrowserNavigationShortcuts />
                                            <CommandPaletteProvider>
                                                <RealtimeProvider>
                                                    <PublicSessionShareJobResumer />
                                                    <HorizontalSafeAreaWrapper>
                                                        <SidebarNavigator />
                                                    </HorizontalSafeAreaWrapper>
                                                    <OtaPreviewFloatingButton visible={showOtaFloatingSwitcher} />
                                                </RealtimeProvider>
                                            </CommandPaletteProvider>
                                            <ImageViewerHost />
                                        </DesktopSettingsModalProvider>
                                    </UnifiedAuthQrCodeProvider>
                                </ModalProvider>
                            </ThemeProvider>
                        </AuthProvider>
                    </ThemeCaptureRoot>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
    if (tracking) providers = <PostHogProvider client={tracking}>{providers}</PostHogProvider>;
    return <><FaviconPermissionIndicator /><AndroidAppIconBadge />{providers}</>;
}
