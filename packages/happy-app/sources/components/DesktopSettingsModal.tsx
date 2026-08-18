import { SettingsView } from '@/components/SettingsView';
import {
    DesktopSettingsNavigationContext,
    type SettingsModalParams,
    type SettingsModalRouter,
} from '@/components/DesktopSettingsNavigation';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { Modal, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';

type DesktopSettingsModalController = {
    closeSettings: () => void;
    isDesktop: boolean;
    openSettings: () => void;
};

type SettingsRoute = {
    params: SettingsModalParams;
    pathname: string;
};

const SETTINGS_ROOT_ROUTE: SettingsRoute = { pathname: '/settings', params: {} };

const SETTINGS_TITLES: Record<string, () => string> = {
    '/settings': () => t('settings.title'),
    '/settings/account': () => t('settings.account'),
    '/settings/agents': () => t('settings.agentDefaults'),
    '/settings/appearance': () => t('settings.appearance'),
    '/settings/ask': () => t('settings.askApi'),
    '/settings/connect/claude': () => t('connectClaude.title'),
    '/settings/custom-instructions': () => t('settings.customInstructions'),
    '/settings/features': () => t('settings.features'),
    '/settings/language': () => t('settings.language'),
    '/settings/my-agents': () => t('agents.title'),
    '/settings/profile': () => t('settingsAccount.editProfile'),
    '/settings/public-image-gateway': () => t('settings.publicImageGateway'),
    '/settings/skill': () => t('settingsSkills.detailTitle'),
    '/settings/skills': () => t('settingsSkills.title'),
    '/settings/usage': () => t('settings.usage'),
    '/settings/voice': () => t('settings.voiceAssistant'),
    '/settings/voice/language': () => t('settingsVoice.languageTitle'),
};

const SettingsAccountScreen = React.lazy(() => import('@/app/(app)/settings/account'));
const SettingsAgentsScreen = React.lazy(() => import('@/app/(app)/settings/agents'));
const SettingsAppearanceScreen = React.lazy(() => import('@/app/(app)/settings/appearance'));
const SettingsAskScreen = React.lazy(() => import('@/app/(app)/settings/ask'));
const SettingsClaudeScreen = React.lazy(() => import('@/app/(app)/settings/connect/claude'));
const SettingsCustomInstructionsScreen = React.lazy(() => import('@/app/(app)/settings/custom-instructions'));
const SettingsFeaturesScreen = React.lazy(() => import('@/app/(app)/settings/features'));
const SettingsLanguageScreen = React.lazy(() => import('@/app/(app)/settings/language'));
const SettingsMyAgentEditScreen = React.lazy(() => import('@/app/(app)/settings/my-agent-edit'));
const SettingsMyAgentsScreen = React.lazy(() => import('@/app/(app)/settings/my-agents'));
const SettingsProfileScreen = React.lazy(() => import('@/app/(app)/settings/profile'));
const SettingsPublicImageGatewayScreen = React.lazy(() => import('@/app/(app)/settings/public-image-gateway'));
const SettingsSkillScreen = React.lazy(() => import('@/app/(app)/settings/skill'));
const SettingsSkillsScreen = React.lazy(() => import('@/app/(app)/settings/skills'));
const SettingsUsageScreen = React.lazy(() => import('@/app/(app)/settings/usage'));
const SettingsVoiceLanguageScreen = React.lazy(() => import('@/app/(app)/settings/voice/language'));
const SettingsVoiceScreen = React.lazy(() => import('@/app/(app)/settings/voice'));

const SETTINGS_SCREENS: Record<string, React.ComponentType> = {
    '/settings': SettingsView,
    '/settings/account': SettingsAccountScreen,
    '/settings/agents': SettingsAgentsScreen,
    '/settings/appearance': SettingsAppearanceScreen,
    '/settings/ask': SettingsAskScreen,
    '/settings/connect/claude': SettingsClaudeScreen,
    '/settings/custom-instructions': SettingsCustomInstructionsScreen,
    '/settings/features': SettingsFeaturesScreen,
    '/settings/language': SettingsLanguageScreen,
    '/settings/my-agent-edit': SettingsMyAgentEditScreen,
    '/settings/my-agents': SettingsMyAgentsScreen,
    '/settings/profile': SettingsProfileScreen,
    '/settings/public-image-gateway': SettingsPublicImageGatewayScreen,
    '/settings/skill': SettingsSkillScreen,
    '/settings/skills': SettingsSkillsScreen,
    '/settings/usage': SettingsUsageScreen,
    '/settings/voice': SettingsVoiceScreen,
    '/settings/voice/language': SettingsVoiceLanguageScreen,
};

const DesktopSettingsModalContext = React.createContext<DesktopSettingsModalController | null>(null);

export function useDesktopSettingsModal(): DesktopSettingsModalController {
    const controller = React.useContext(DesktopSettingsModalContext);
    if (!controller) {
        throw new Error('useDesktopSettingsModal must be used within DesktopSettingsModalProvider');
    }
    return controller;
}

function toSettingsRoute(href: unknown): SettingsRoute | null {
    const rawPathname = typeof href === 'string'
        ? href.split('?')[0]
        : typeof href === 'object' && href !== null && 'pathname' in href
            ? String((href as { pathname: unknown }).pathname)
            : null;
    if (!rawPathname || !SETTINGS_SCREENS[rawPathname]) {
        return null;
    }

    const params: SettingsModalParams = {};
    if (typeof href === 'string') {
        const query = href.split('?')[1];
        for (const [key, value] of new URLSearchParams(query ?? '').entries()) {
            params[key] = value;
        }
    } else if (typeof href === 'object' && href !== null && 'params' in href) {
        for (const [key, value] of Object.entries((href as { params?: Record<string, unknown> }).params ?? {})) {
            params[key] = value === undefined || value === null ? undefined : String(value);
        }
    }

    return { pathname: rawPathname, params };
}

export function DesktopSettingsModalProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' && isTablet;
    const [visible, setVisible] = React.useState(false);
    const [openInstance, setOpenInstance] = React.useState(0);

    React.useEffect(() => {
        if (!isDesktop) {
            setVisible(false);
        }
    }, [isDesktop]);

    const closeSettings = React.useCallback(() => {
        setVisible(false);
    }, []);

    const openSettings = React.useCallback(() => {
        if (isDesktop) {
            setOpenInstance((instance) => instance + 1);
            setVisible(true);
            return;
        }
        router.push('/settings');
    }, [isDesktop, router]);

    const controller = React.useMemo(() => ({
        closeSettings,
        isDesktop,
        openSettings,
    }), [closeSettings, isDesktop, openSettings]);

    return (
        <DesktopSettingsModalContext.Provider value={controller}>
            {children}
            {isDesktop ? (
                <DesktopSettingsModal
                    appRouter={router}
                    key={openInstance}
                    onClose={closeSettings}
                    visible={visible}
                />
            ) : null}
        </DesktopSettingsModalContext.Provider>
    );
}

function DesktopSettingsModal({
    appRouter,
    onClose,
    visible,
}: {
    appRouter: ReturnType<typeof useRouter>;
    onClose: () => void;
    visible: boolean;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const modalPanelRef = React.useRef<any>(null);
    const [history, setHistory] = React.useState<SettingsRoute[]>([SETTINGS_ROOT_ROUTE]);
    const currentRoute = history.at(-1) ?? SETTINGS_ROOT_ROUTE;
    const CurrentScreen = SETTINGS_SCREENS[currentRoute.pathname] ?? SettingsView;

    const navigate = React.useCallback((href: any, replace = false) => {
        const route = toSettingsRoute(href);
        if (!route) {
            onClose();
            if (replace) {
                appRouter.replace(href);
            } else {
                appRouter.push(href);
            }
            return;
        }
        setHistory((current) => replace
            ? [...current.slice(0, -1), route]
            : [...current, route]);
    }, [appRouter, onClose]);

    const goBack = React.useCallback(() => {
        setHistory((current) => {
            if (current.length === 1) {
                onClose();
                return current;
            }
            return current.slice(0, -1);
        });
    }, [onClose]);

    const settingsRouter = React.useMemo<SettingsModalRouter>(() => ({
        back: goBack,
        navigate,
        push: navigate,
        replace: (href) => navigate(href, true),
    }), [goBack, navigate]);

    const handleKeyDown = React.useCallback((event: {
        nativeEvent?: { key?: string; shiftKey?: boolean };
        preventDefault?: () => void;
    }) => {
        const key = event.nativeEvent?.key;
        if (key === 'Escape') {
            event.preventDefault?.();
            onClose();
            return;
        }
        if (key !== 'Tab' || typeof document === 'undefined') return;

        const focusable = Array.from(modalPanelRef.current?.querySelectorAll?.(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []) as HTMLElement[];
        if (focusable.length === 0) return;

        const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const backward = event.nativeEvent?.shiftKey && activeIndex <= 0;
        const forward = !event.nativeEvent?.shiftKey && activeIndex === focusable.length - 1;
        if (backward || forward) {
            event.preventDefault?.();
            (backward ? focusable.at(-1) : focusable[0])?.focus();
        }
    }, [onClose]);

    React.useEffect(() => {
        if (!visible || typeof document === 'undefined') return;
        const focusCloseButton = () => (Array.from(modalPanelRef.current?.querySelectorAll?.(
            '[data-testid="settings-modal-close"]',
        ) ?? []) as HTMLElement[])
            .find((button) => button.offsetParent !== null)
            ?.focus();
        const frame = requestAnimationFrame(focusCloseButton);
        return () => cancelAnimationFrame(frame);
    }, [visible]);

    return (
        <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
            <View
                style={[
                    styles.modalRoot,
                    {
                        paddingBottom: Math.max(24, safeArea.bottom + 24),
                        paddingTop: Math.max(24, safeArea.top + 24),
                    },
                ]}
                testID="settings-modal-root"
                {...({ onKeyDown: handleKeyDown } as any)}
            >
                <Pressable
                    accessible={false}
                    onPress={onClose}
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: theme.colors.shadow.color, opacity: 0.42 },
                    ]}
                    testID="settings-modal-backdrop"
                />
                <View
                    accessibilityLabel={t('settings.title')}
                    accessibilityViewIsModal
                    ref={modalPanelRef}
                    style={styles.modalPanel}
                    testID="settings-modal-panel"
                    {...({ 'aria-modal': true, role: 'dialog' } as any)}
                >
                    <View style={styles.header}>
                        {history.length > 1 ? (
                            <Pressable
                                accessibilityLabel={t('common.back')}
                                accessibilityRole="button"
                                hitSlop={8}
                                onPress={goBack}
                                style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
                                testID="settings-modal-back"
                            >
                                <Ionicons color={theme.colors.header.tint} name="chevron-back" size={22} />
                            </Pressable>
                        ) : <View style={styles.headerPlaceholder} />}
                        <Text style={styles.headerTitle}>{(SETTINGS_TITLES[currentRoute.pathname] ?? SETTINGS_TITLES['/settings'])()}</Text>
                        <Pressable
                            accessibilityLabel={t('common.cancel')}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={onClose}
                            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
                            testID="settings-modal-close"
                        >
                            <Ionicons color={theme.colors.header.tint} name="close" size={22} />
                        </Pressable>
                    </View>
                    <View style={styles.content}>
                        <DesktopSettingsNavigationContext.Provider value={{
                            params: currentRoute.params,
                            router: settingsRouter,
                        }}>
                            <React.Suspense fallback={null}>
                                <CurrentScreen />
                            </React.Suspense>
                        </DesktopSettingsNavigationContext.Provider>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: {
        flex: 1,
    },
    header: {
        alignItems: 'center',
        backgroundColor: theme.colors.header.background,
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 56,
        paddingHorizontal: 14,
    },
    headerButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 6,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    headerButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    headerPlaceholder: {
        height: 36,
        width: 36,
    },
    headerTitle: {
        color: theme.colors.header.tint,
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
    modalPanel: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        boxShadow: `0 16px 44px ${theme.colors.shadow.color}`,
        flex: 1,
        maxHeight: 900,
        maxWidth: 840,
        overflow: 'hidden',
        width: '100%',
    },
    modalRoot: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
}));
