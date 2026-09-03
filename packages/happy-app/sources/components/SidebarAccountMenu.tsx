import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { getAvatarUrl, type Profile } from '@/sync/profile';
import { t } from '@/text';

type SidebarAccountMenuProps = {
    desktopDensity?: boolean;
    iconOnly?: boolean;
    displayName: string;
    onNavigate: (path: string) => void;
    onOpenSettings?: () => void;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    profile: Profile;
    restoreFocusOnClose?: boolean;
    unreadCount?: number;
};

type MenuActionProps = {
    destructive?: boolean;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
    testID: string;
};

const MenuAction = React.forwardRef<any, MenuActionProps>(function MenuAction({
    destructive = false,
    icon,
    label,
    onPress,
    testID,
}, ref) {
    const { theme } = useUnistyles();
    const color = destructive ? theme.colors.status.error : theme.colors.text;

    return (
        <Pressable
            ref={ref}
            accessibilityRole="button"
            onPress={onPress}
            style={({ pressed }) => [styles.menuAction, pressed && styles.pressed]}
            testID={testID}
        >
            <Ionicons color={color} name={icon} size={17} />
            <Text numberOfLines={1} style={[styles.menuActionText, { color }]}>
                {label}
            </Text>
        </Pressable>
    );
});

export const SidebarAccountMenu = React.memo(function SidebarAccountMenu({
    desktopDensity = false,
    iconOnly = false,
    displayName,
    onNavigate,
    onOpenSettings,
    onOpenChange,
    open,
    profile,
    restoreFocusOnClose = true,
    unreadCount = 0,
}: SidebarAccountMenuProps) {
    const { logout } = useAuth();
    const { theme } = useUnistyles();
    const triggerRef = React.useRef<any>(null);
    const firstActionRef = React.useRef<any>(null);
    const wasOpenRef = React.useRef(false);
    const avatarUrl = getAvatarUrl(profile);

    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            wasOpenRef.current = open;
            return;
        }

        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = open;
        const timeout = setTimeout(() => {
            if (open) {
                firstActionRef.current?.focus?.();
            } else if (wasOpen && restoreFocusOnClose) {
                triggerRef.current?.focus?.();
            }
        }, 0);

        return () => clearTimeout(timeout);
    }, [open, restoreFocusOnClose]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !open || typeof window === 'undefined') {
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
    }, [onOpenChange, open]);

    const navigate = React.useCallback((path: string) => {
        onOpenChange(false);
        onNavigate(path);
    }, [onNavigate, onOpenChange]);

    const confirmLogout = React.useCallback(() => {
        onOpenChange(false);
        void (async () => {
            const confirmed = await Modal.confirm(
                t('common.logout'),
                t('settingsAccount.logoutConfirm'),
                { confirmText: t('common.logout'), destructive: true },
            );
            if (confirmed) {
                await logout();
            }
        })();
    }, [logout, onOpenChange]);

    return (
        <View
            style={[
                styles.footer,
                desktopDensity ? styles.footerDesktop : styles.footerRegular,
            ]}
            testID="sidebar-account-footer"
        >
            {open ? (
                <View
                    accessibilityViewIsModal
                    style={[
                        styles.menu,
                        iconOnly ? styles.menuIconRail : desktopDensity ? styles.menuDesktop : styles.menuRegular,
                    ]}
                    testID="sidebar-account-menu"
                >
                    <MenuAction
                        ref={firstActionRef}
                        icon="person-circle-outline"
                        label={t('settingsAccount.profile')}
                        onPress={() => navigate('/settings/profile')}
                        testID="sidebar-account-profile-action"
                    />
                    <MenuAction
                        icon="settings-outline"
                        label={t('settings.title')}
                        onPress={() => {
                            if (!onOpenSettings) {
                                navigate('/settings');
                                return;
                            }
                            onOpenChange(false);
                            onOpenSettings();
                        }}
                        testID="sidebar-account-settings-action"
                    />
                    <MenuAction
                        icon="shield-checkmark-outline"
                        label={t('settings.account')}
                        onPress={() => navigate('/settings/account')}
                        testID="sidebar-account-details-action"
                    />
                    <View style={styles.dangerGroup}>
                        <MenuAction
                            destructive
                            icon="log-out-outline"
                            label={t('settingsAccount.logout')}
                            onPress={confirmLogout}
                            testID="sidebar-account-logout-action"
                        />
                    </View>
                </View>
            ) : null}

            <Pressable
                ref={triggerRef}
                aria-expanded={open}
                aria-haspopup="menu"
                accessibilityHint={t('settings.accountSubtitle')}
                accessibilityLabel={displayName}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                onPress={() => onOpenChange(!open)}
                style={({ pressed }) => [
                    styles.trigger,
                    desktopDensity && styles.triggerDesktop,
                    iconOnly && styles.triggerIconRail,
                    pressed && styles.pressed,
                ]}
                testID="sidebar-account-trigger"
            >
                <Avatar
                    id={profile.id}
                    imageUrl={avatarUrl}
                    size={desktopDensity ? 30 : 38}
                    thumbhash={profile.avatar?.thumbhash}
                />
                {!iconOnly ? <Text numberOfLines={1} style={styles.displayName}>{displayName}</Text> : null}
                {unreadCount > 0 ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                    </View>
                ) : null}
                {!iconOnly ? <Ionicons
                    color={theme.colors.textSecondary}
                    name={open ? 'chevron-down' : 'chevron-up'}
                    size={15}
                /> : null}
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    footer: {
        position: 'relative',
        zIndex: 20,
        backgroundColor: theme.colors.groupped.background,
    },
    footerRegular: {
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 8,
    },
    footerDesktop: {
        paddingHorizontal: 10,
        paddingTop: 3,
        paddingBottom: 4,
    },
    trigger: {
        minHeight: 58,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    triggerDesktop: {
        minHeight: 44,
        borderRadius: 10,
        paddingHorizontal: 9,
        gap: 8,
    },
    triggerIconRail: {
        borderWidth: 0,
        height: 44,
        justifyContent: 'center',
        minHeight: 44,
        paddingHorizontal: 0,
        width: 44,
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    displayName: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    menu: {
        position: 'absolute',
        bottom: '100%',
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
    menuRegular: {
        left: 16,
        right: 16,
    },
    menuDesktop: {
        left: 10,
        right: 10,
    },
    menuIconRail: {
        left: '100%',
        top: 0,
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
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    dangerGroup: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
}));
