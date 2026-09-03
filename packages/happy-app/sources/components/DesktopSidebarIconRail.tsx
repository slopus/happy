import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Profile } from '@/sync/profile';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SidebarAccountMenu } from './SidebarAccountMenu';
import { SidebarHelpMenu } from './SidebarHelpMenu';
import { usePluginSurfaceViews } from './plugins/usePluginSurfaceViews';

type FooterMenu = 'account' | 'help' | null;

type Props = {
    displayName: string;
    footerMenu: FooterMenu;
    onFooterMenuChange: (menu: FooterMenu) => void;
    onNavigate: (path: string) => void;
    onOpenAgents: () => void;
    onOpenPluginMarketplace: () => void;
    onOpenSessionSearch: () => void;
    onOpenSettings: () => void;
    profile: Profile;
    unreadCount: number;
};

export const DesktopSidebarIconRail = React.memo(function DesktopSidebarIconRail(props: Props) {
    const pathname = usePathname();
    const pluginViews = usePluginSurfaceViews('left-sidebar');
    const showConversationHistory = pluginViews.some((view) => view.componentId === 'relationship-advisor-history');

    return (
        <View style={styles.rail} testID="desktop-sidebar-icon-rail">
            <View style={styles.accountSlot}>
                <SidebarAccountMenu
                    desktopDensity
                    displayName={props.displayName}
                    iconOnly
                    onNavigate={props.onNavigate}
                    onOpenSettings={props.onOpenSettings}
                    onOpenChange={(open) => props.onFooterMenuChange(open ? 'account' : null)}
                    open={props.footerMenu === 'account'}
                    profile={props.profile}
                    restoreFocusOnClose={props.footerMenu !== 'help'}
                    unreadCount={props.unreadCount}
                />
            </View>
            <View style={styles.primaryActions}>
                <RailAction icon="create-outline" label={t('sidebar.newSession')} onPress={() => props.onNavigate('/new')} testID="sidebar-new-session-button" />
                <RailAction badge={props.unreadCount} icon="checkmark-outline" label={t('tabs.inbox')} onPress={() => props.onNavigate('/inbox')} testID="sidebar-inbox-button" />
                <RailAction icon="search-outline" label={t('sidebar.searchSessions')} onPress={props.onOpenSessionSearch} testID="sidebar-command-palette-button" />
                <RailAction icon="extension-puzzle-outline" label={t('relationshipAdvisorPlugin.marketTitle')} onPress={props.onOpenPluginMarketplace} testID="sidebar-plugins-button" />
                <RailAction icon="people-outline" label={t('agents.cardTitle')} onPress={props.onOpenAgents} testID="sidebar-my-agents-button" />
                {showConversationHistory ? (
                    <RailAction icon="chatbubbles-outline" label={t('relationshipAdvisor.historyTitle')} onPress={() => props.onNavigate('/relationship-advisor')} selected={pathname === '/relationship-advisor'} testID="sidebar-conversation-history-button" />
                ) : null}
            </View>
            <View style={styles.bottomActions}>
                <RailAction icon="notifications-outline" label={t('pushNotifications.title')} onPress={() => props.onNavigate('/settings/account')} testID="sidebar-notifications-button" />
                <SidebarHelpMenu
                    iconRail
                    onOpenChange={(open) => props.onFooterMenuChange(open ? 'help' : null)}
                    open={props.footerMenu === 'help'}
                    restoreFocusOnClose={props.footerMenu !== 'account'}
                />
            </View>
        </View>
    );
});

function RailAction({ badge = 0, icon, label, onPress, selected = false, testID }: {
    badge?: number;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
    selected?: boolean;
    testID: string;
}) {
    const { theme } = useUnistyles();
    const [tooltipVisible, setTooltipVisible] = React.useState(false);
    return (
        <View style={styles.actionWrap}>
            <Pressable
                aria-current={selected ? 'page' : undefined}
                accessibilityLabel={label}
                accessibilityRole="button"
                onBlur={() => setTooltipVisible(false)}
                onFocus={() => setTooltipVisible(true)}
                onHoverIn={Platform.OS === 'web' ? () => setTooltipVisible(true) : undefined}
                onHoverOut={Platform.OS === 'web' ? () => setTooltipVisible(false) : undefined}
                onPress={onPress}
                style={({ pressed }) => [styles.action, selected && styles.actionSelected, pressed && styles.actionPressed]}
                testID={testID}
            >
                <Ionicons color={theme.colors.textSecondary} name={icon} size={22} />
                {badge > 0 ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                    </View>
                ) : null}
            </Pressable>
            {tooltipVisible ? (
                <View accessibilityRole="text" style={styles.tooltip} testID={`${testID}-tooltip`}>
                    <Text numberOfLines={1} style={styles.tooltipText}>{label}</Text>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    rail: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRightColor: theme.colors.divider,
        borderRightWidth: StyleSheet.hairlineWidth,
        flexShrink: 0,
        paddingBottom: 6,
        paddingTop: 6,
        width: 58,
        zIndex: 60,
    },
    accountSlot: { alignItems: 'center', width: '100%', zIndex: 70 },
    primaryActions: { alignItems: 'center', gap: 4, marginTop: 10, width: '100%' },
    bottomActions: { alignItems: 'center', gap: 4, marginTop: 'auto', width: '100%', zIndex: 70 },
    actionWrap: { alignItems: 'center', position: 'relative', width: '100%', zIndex: 65 },
    action: { alignItems: 'center', borderRadius: 10, height: 44, justifyContent: 'center', position: 'relative', width: 44 },
    actionPressed: { backgroundColor: theme.colors.surfacePressed },
    actionSelected: { backgroundColor: theme.colors.surfaceSelected },
    badge: {
        alignItems: 'center',
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        height: 16,
        justifyContent: 'center',
        minWidth: 16,
        paddingHorizontal: 3,
        position: 'absolute',
        right: 2,
        top: 2,
    },
    badgeText: { color: theme.colors.button.destructive.tint, fontSize: 9, ...Typography.default('semiBold') },
    tooltip: {
        backgroundColor: theme.colors.text,
        borderRadius: 8,
        left: 54,
        paddingHorizontal: 10,
        paddingVertical: 7,
        position: 'absolute',
        top: 6,
        zIndex: 100,
    },
    tooltipText: { color: theme.colors.surface, fontSize: 12, ...Typography.default('semiBold') },
}));
