import { Header, createHeader } from '@/components/navigation/Header';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { useIsTablet } from '@/utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export const unstable_settings = {
    initialRouteName: 'index',
};

function SettingsHeaderButton(props: {
    accessibilityLabel: string;
    icon: 'chevron-back' | 'close';
    onPress: () => void;
    testID: string;
}) {
    const { theme } = useUnistyles();

    return (
        <Pressable
            accessibilityLabel={props.accessibilityLabel}
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onPress}
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
            testID={props.testID}
        >
            <Ionicons
                accessibilityElementsHidden
                color={theme.colors.header.tint}
                importantForAccessibility="no-hide-descendants"
                name={props.icon}
                size={22}
            />
        </Pressable>
    );
}

function SettingsModalHeader(props: NativeStackHeaderProps & { onClose: () => void }) {
    const { theme } = useUnistyles();
    const titleOption = props.options.headerTitle ?? props.options.title;
    let title: React.ReactNode = null;

    if (typeof titleOption === 'string') {
        title = (
            <Text style={[styles.headerTitle, props.options.headerTitleStyle]}>
                {titleOption}
            </Text>
        );
    } else if (typeof titleOption === 'function') {
        title = titleOption({
            children: props.route.name,
            tintColor: props.options.headerTintColor,
        });
    }

    return (
        <Header
            headerLeft={props.back ? () => (
                <SettingsHeaderButton
                    accessibilityLabel={t('common.back')}
                    icon="chevron-back"
                    onPress={props.navigation.goBack}
                    testID="settings-modal-back"
                />
            ) : null}
            headerRight={() => (
                <SettingsHeaderButton
                    accessibilityLabel={t('common.cancel')}
                    icon="close"
                    onPress={props.onClose}
                    testID="settings-modal-close"
                />
            )}
            headerShadowVisible={false}
            headerStyle={{
                backgroundColor: theme.colors.header.background,
                borderBottomColor: theme.colors.divider,
                borderBottomWidth: StyleSheet.hairlineWidth,
            }}
            safeAreaEnabled={false}
            title={title}
        />
    );
}

export default function SettingsLayout() {
    const router = useRouter();
    const modalPanelRef = React.useRef<any>(null);
    const isTablet = useIsTablet();
    const safeArea = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const isDesktopModal = Platform.OS === 'web' && isTablet;
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';

    const closeSettings = React.useCallback(() => {
        if (isDesktopModal) {
            router.dismissTo('/');
            return;
        }
        if (router.canDismiss()) {
            router.dismiss();
            return;
        }
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace('/');
    }, [isDesktopModal, router]);

    const handleModalKeyDown = React.useCallback((event: { nativeEvent?: { key?: string; shiftKey?: boolean }; preventDefault?: () => void }) => {
        const key = event.nativeEvent?.key;
        if (key === 'Escape') {
            event.preventDefault?.();
            closeSettings();
            return;
        }
        if (key === 'Tab' && typeof document !== 'undefined') {
            const focusable = Array.from(modalPanelRef.current?.querySelectorAll?.(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? []) as HTMLElement[];
            if (focusable.length === 0) return;

            const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
            const isLeavingBackward = event.nativeEvent?.shiftKey && activeIndex <= 0;
            const isLeavingForward = !event.nativeEvent?.shiftKey && activeIndex === focusable.length - 1;
            if (isLeavingBackward || isLeavingForward) {
                event.preventDefault?.();
                (isLeavingBackward ? focusable.at(-1) : focusable[0])?.focus();
            }
        }
    }, [closeSettings]);

    React.useEffect(() => {
        if (!isDesktopModal || typeof document === 'undefined') return;
        const focusCloseButton = () => (Array.from(modalPanelRef.current?.querySelectorAll?.(
            '[data-testid="settings-modal-close"]',
        ) ?? []) as HTMLElement[])
            .find(button => button.offsetParent !== null)
            ?.focus();
        const frame = requestAnimationFrame(focusCloseButton);
        return () => cancelAnimationFrame(frame);
    }, [isDesktopModal]);

    const navigator = (
        <Stack
            initialRouteName="index"
            screenOptions={{
                contentStyle: {
                    backgroundColor: theme.colors.surface,
                },
                header: isDesktopModal
                    ? (props) => <SettingsModalHeader {...props} onClose={closeSettings} />
                    : shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: t('common.back'),
                headerShadowVisible: false,
                headerStyle: {
                    backgroundColor: theme.colors.header.background,
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },
            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerLeft: isDesktopModal ? undefined : () => (
                        <SettingsHeaderButton
                            accessibilityLabel={t('common.back')}
                            icon="chevron-back"
                            onPress={closeSettings}
                            testID="settings-page-back"
                        />
                    ),
                    headerTitle: t('settings.title'),
                }}
            />
            <Stack.Screen name="account" options={{ headerTitle: t('settings.account') }} />
            <Stack.Screen name="profile" options={{ headerTitle: t('settingsAccount.editProfile') }} />
            <Stack.Screen name="usage" options={{ headerTitle: t('settings.usage') }} />
            <Stack.Screen name="appearance" options={{ headerTitle: t('settings.appearance') }} />
            <Stack.Screen name="language" options={{ headerTitle: t('settings.language') }} />
            <Stack.Screen name="agents" options={{ headerTitle: t('settings.agentDefaults') }} />
            <Stack.Screen name="ask" options={{ headerTitle: t('settings.askApi') }} />
            <Stack.Screen name="public-image-gateway" options={{ headerTitle: t('settings.publicImageGateway') }} />
            <Stack.Screen name="my-agents" options={{ headerTitle: t('agents.title') }} />
            <Stack.Screen name="my-agent-edit" options={{ headerTitle: '' }} />
            <Stack.Screen name="features" options={{ headerTitle: t('settings.features') }} />
            <Stack.Screen name="custom-instructions" options={{ headerTitle: t('settings.customInstructions') }} />
            <Stack.Screen name="skills" options={{ headerTitle: t('settingsSkills.title') }} />
            <Stack.Screen name="skill" options={{ headerTitle: t('settingsSkills.detailTitle') }} />
            <Stack.Screen name="voice" options={{ headerTitle: t('settings.voiceAssistant') }} />
            <Stack.Screen name="voice/language" options={{ headerTitle: t('settingsVoice.languageTitle') }} />
            <Stack.Screen name="connect/claude" options={{ headerTitle: t('connectClaude.title') }} />
        </Stack>
    );

    if (!isDesktopModal) {
        return navigator;
    }

    return (
        <View
            style={[
                styles.modalRoot,
                {
                    paddingBottom: Math.max(24, safeArea.bottom + 24),
                    paddingTop: Math.max(24, safeArea.top + 24),
                },
            ]}
            testID="settings-modal-root"
            {...({ onKeyDown: handleModalKeyDown } as any)}
        >
            <Pressable
                accessible={false}
                onPress={closeSettings}
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: theme.colors.shadow.color,
                        opacity: 0.42,
                    },
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
                {navigator}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    modalRoot: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
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
    headerTitle: {
        color: theme.colors.header.tint,
        fontSize: 17,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));
