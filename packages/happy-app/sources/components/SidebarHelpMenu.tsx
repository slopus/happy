import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useKeyboardShortcutsLauncher } from '@/components/KeyboardShortcuts';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';

const SUPPORT_URL = 'https://github.com/wangjs-jacky/happy/issues';

type SidebarHelpMenuProps = {
    iconRail?: boolean;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    restoreFocusOnClose?: boolean;
};

type MenuActionProps = {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
    testID: string;
};

const MenuAction = React.forwardRef<any, MenuActionProps>(function MenuAction({
    icon,
    label,
    onPress,
    testID,
}, ref) {
    const { theme } = useUnistyles();

    return (
        <Pressable
            ref={ref}
            accessibilityRole="menuitem"
            onPress={onPress}
            style={({ pressed }) => [styles.menuAction, pressed && styles.pressed]}
            testID={testID}
        >
            <Ionicons color={theme.colors.text} name={icon} size={17} />
            <Text numberOfLines={1} style={styles.menuActionText}>
                {label}
            </Text>
        </Pressable>
    );
});

export const SidebarHelpMenu = React.memo(function SidebarHelpMenu({
    iconRail = false,
    onOpenChange,
    open,
    restoreFocusOnClose = true,
}: SidebarHelpMenuProps) {
    const { theme } = useUnistyles();
    const launcher = useKeyboardShortcutsLauncher();
    const launcherAvailable = launcher?.isAvailable === true;
    const triggerRef = React.useRef<any>(null);
    const firstActionRef = React.useRef<any>(null);
    const wasOpenRef = React.useRef(false);
    const skipNextClosedFocusRef = React.useRef(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !launcherAvailable) {
            wasOpenRef.current = open;
            return;
        }

        const wasOpen = wasOpenRef.current;
        const shouldRestoreTrigger = wasOpen
            && !open
            && restoreFocusOnClose
            && !skipNextClosedFocusRef.current;
        if (wasOpen && !open && skipNextClosedFocusRef.current) {
            skipNextClosedFocusRef.current = false;
        }
        wasOpenRef.current = open;

        const timeout = setTimeout(() => {
            if (open) {
                firstActionRef.current?.focus?.();
            } else if (shouldRestoreTrigger) {
                triggerRef.current?.focus?.();
            }
        }, 0);

        return () => clearTimeout(timeout);
    }, [launcherAvailable, open, restoreFocusOnClose]);

    React.useEffect(() => {
        if (!launcherAvailable || Platform.OS !== 'web' || !open || typeof window === 'undefined') {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            onOpenChange(false);
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [launcherAvailable, onOpenChange, open]);

    React.useEffect(() => {
        if (!launcherAvailable && open) {
            onOpenChange(false);
        }
    }, [launcherAvailable, onOpenChange, open]);

    const openKeyboardShortcuts = React.useCallback(() => {
        skipNextClosedFocusRef.current = true;
        onOpenChange(false);
        triggerRef.current?.focus?.();
        launcher?.open();
    }, [launcher, onOpenChange]);

    const openSupport = React.useCallback(() => {
        onOpenChange(false);
        void openExternalUrl(SUPPORT_URL);
    }, [onOpenChange]);

    if (!launcherAvailable) {
        return null;
    }

    return (
        <View style={styles.footer} testID="sidebar-help-footer">
            {open ? (
                <View
                    accessibilityLabel={t('keyboardShortcuts.help')}
                    accessibilityRole="menu"
                    accessibilityViewIsModal
                    style={[styles.menu, iconRail && styles.menuIconRail]}
                    testID="sidebar-help-menu"
                >
                    <MenuAction
                        ref={firstActionRef}
                        icon="flash-outline"
                        label={t('keyboardShortcuts.title')}
                        onPress={openKeyboardShortcuts}
                        testID="sidebar-help-shortcuts-action"
                    />
                    <View style={styles.reportGroup}>
                        <MenuAction
                            icon="help-buoy-outline"
                            label={t('settings.reportIssue')}
                            onPress={openSupport}
                            testID="sidebar-help-report-action"
                        />
                    </View>
                </View>
            ) : null}

            <Pressable
                ref={triggerRef}
                aria-expanded={open}
                aria-haspopup="menu"
                accessibilityLabel={t('keyboardShortcuts.help')}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                onPress={() => onOpenChange(!open)}
                style={({ pressed }) => [styles.trigger, iconRail && styles.triggerIconRail, pressed && styles.pressed]}
                testID="sidebar-help-trigger"
            >
                <Ionicons color={theme.colors.textSecondary} name="help-circle-outline" size={22} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    footer: {
        position: 'relative',
        zIndex: 20,
        paddingTop: 3,
        paddingRight: 10,
        paddingBottom: 4,
        alignItems: 'flex-end',
        backgroundColor: theme.colors.groupped.background,
    },
    trigger: {
        width: 44,
        minWidth: 44,
        height: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    triggerIconRail: { borderWidth: 0 },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    menu: {
        position: 'absolute',
        right: 10,
        bottom: '100%',
        width: 224,
        marginBottom: 5,
        overflow: 'hidden',
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
    },
    menuIconRail: {
        bottom: 0,
        left: '100%',
        right: undefined,
        width: 224,
        marginLeft: 6,
    },
    menuAction: {
        minHeight: 42,
        paddingHorizontal: 13,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.surface,
    },
    menuActionText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    reportGroup: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
}));
