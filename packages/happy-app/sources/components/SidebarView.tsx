import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useNavigation } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useFriendRequests, useProfile, useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { getDisplayName } from '@/sync/profile';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useDrawerHaptics } from './useDrawerHaptics';
import { AgentSheet } from './agents/AgentSheet';
import { useAgentSpace } from '@/hooks/useAgentSpace';
import { AgentSpaceWorkbench } from './agents/AgentSpaceWorkbench';
import { SidebarAccountMenu } from './SidebarAccountMenu';
import { SidebarHelpMenu } from './SidebarHelpMenu';
import { useCommandPaletteLauncher } from './CommandPalette/CommandPaletteProvider';
import { useDesktopSettingsModal } from './DesktopSettingsModal';
import { DesktopSidebarSessionsNavigation } from './DesktopSidebarSessionsNavigation';
import { PluginMarketplaceModal } from './plugins/PluginMarketplaceModal';
import { PluginLeftSidebarSlot } from './plugins/PluginLeftSidebarSlot';
import { usePluginSurfaceViews } from './plugins/usePluginSurfaceViews';
import { resolvePluginText } from './plugins/pluginText';
import { DESKTOP_PRIMARY_NAVIGATION_WIDTH } from '@/utils/desktopNavigationLayout';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    containerDesktop: {
        borderWidth: 0,
        flexDirection: 'row',
    },
    desktopPrimaryColumn: {
        backgroundColor: theme.colors.groupped.background,
        borderRightColor: theme.colors.divider,
        borderRightWidth: StyleSheet.hairlineWidth,
        overflow: 'visible',
        width: DESKTOP_PRIMARY_NAVIGATION_WIDTH,
        zIndex: 100,
    },
    desktopSecondaryColumn: {
        backgroundColor: theme.colors.groupped.background,
        flex: 1,
        minWidth: 0,
    },
    desktopPrimarySpacer: {
        flex: 1,
    },
    desktopRail: {
        alignItems: 'center',
        gap: 4,
        paddingTop: 4,
        zIndex: 30,
    },
    desktopRailDivider: {
        backgroundColor: theme.colors.divider,
        height: StyleSheet.hairlineWidth,
        marginVertical: 3,
        width: 32,
    },
    desktopRailItem: {
        position: 'relative',
        zIndex: 30,
    },
    desktopRailButton: {
        alignItems: 'center',
        borderRadius: 10,
        height: 44,
        justifyContent: 'center',
        width: 44,
    },
    desktopRailButtonActive: {
        backgroundColor: theme.colors.surfacePressed,
    },
    desktopRailButtonSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    desktopRailTooltip: {
        alignItems: 'center',
        backgroundColor: theme.colors.text,
        borderRadius: 8,
        flexDirection: 'row',
        left: 52,
        minHeight: 30,
        minWidth: 92,
        paddingHorizontal: 10,
        position: 'absolute',
        top: 7,
        zIndex: 1500,
    },
    desktopRailTooltipText: {
        ...Typography.default('semiBold'),
        color: theme.colors.surface,
        flexShrink: 0,
        fontSize: 12,
    },
    messagesRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 2,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 10,
    },
    messagesRowDesktop: {
        marginHorizontal: 10,
        marginTop: 3,
        marginBottom: 1,
        paddingVertical: 7,
        paddingHorizontal: 10,
    },
    messagesText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    badge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 11,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    newSessionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    navigationRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    newSessionButtonDesktop: {
        marginHorizontal: 10,
        marginTop: 3,
        marginBottom: 1,
        paddingVertical: 7,
        paddingHorizontal: 10,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentsCard: {
        marginHorizontal: 16,
        marginTop: 4,
        marginBottom: 6,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 8,
    },
    agentsCardPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    agentsCardDesktop: {
        marginHorizontal: 10,
        marginTop: 3,
        marginBottom: 1,
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 10,
        gap: 0,
    },
    agentsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    agentsTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentsAdd: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 2,
        paddingHorizontal: 6,
        borderRadius: 8,
        gap: 2,
    },
    agentsAddPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    agentsAddText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    agentsAvatars: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    agentMiniAvatar: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    agentMiniGlyph: {
        color: '#FFFFFF',
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    agentsEmpty: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    pluginsButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 8,
        marginBottom: 6,
        marginHorizontal: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    pluginsButtonDesktop: {
        borderRadius: 10,
        marginBottom: 1,
        marginHorizontal: 10,
        marginTop: 3,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    pluginsText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        flex: 1,
        fontSize: 14,
    },
    pluginsChevron: {
        color: theme.colors.textSecondary,
    },
    footerMenuDismissLayer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 10,
    },
    footerMenuSlot: {
        zIndex: 20,
    },
    footerMenusDesktop: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    footerMenusRail: {
        alignItems: 'center',
        flexDirection: 'column',
    },
    accountMenuSlot: {
        flex: 1,
        minWidth: 0,
    },
    primaryNavigation: {
        paddingTop: 2,
    },
    secondaryNavigation: {
        marginTop: 5,
    },
    secondaryNavigationDivider: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: 10,
        marginBottom: 3,
        backgroundColor: theme.colors.divider,
    },
}));

interface SidebarViewProps {
    closeDrawerOnNavigate?: boolean;
    desktopDensity?: boolean;
    desktopPrimaryNavigation?: boolean;
}

type FooterMenu = 'account' | 'help' | null;

function DesktopRailItem({
    badge,
    icon,
    label,
    onPress,
    selected = false,
    testID,
}: {
    badge?: number;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    onPress: () => void;
    selected?: boolean;
    testID: string;
}) {
    const styles = stylesheet;
    const [active, setActive] = React.useState(false);
    const itemKey = testID.replace('sidebar-', '').replace('-button', '');

    return (
        <View style={styles.desktopRailItem}>
            <Pressable
                accessibilityLabel={label}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onBlur={() => setActive(false)}
                onFocus={() => setActive(true)}
                onHoverIn={() => setActive(true)}
                onHoverOut={() => setActive(false)}
                onPress={onPress}
                style={({ pressed }) => [
                    styles.desktopRailButton,
                    selected && styles.desktopRailButtonSelected,
                    (active || pressed) && styles.desktopRailButtonActive,
                ]}
                testID={testID}
            >
                <Ionicons
                    color={selected ? stylesheet.newSessionText.color : stylesheet.pluginsChevron.color}
                    name={icon}
                    size={21}
                />
                {badge && badge > 0 ? (
                    <View style={[styles.badge, { position: 'absolute', right: 2, top: 2 }]}>
                        <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                    </View>
                ) : null}
            </Pressable>
            {active ? (
                <View
                    pointerEvents="none"
                    style={styles.desktopRailTooltip}
                    testID={`desktop-navigation-rail-tooltip-${itemKey}`}
                >
                    <Text numberOfLines={1} style={styles.desktopRailTooltipText}>{label}</Text>
                </View>
            ) : null}
        </View>
    );
}

function DesktopPluginRailItems({ onNavigate }: { onNavigate: (path: string) => void }) {
    const views = usePluginSurfaceViews('left-sidebar');

    return views.map((view) => view.path ? (
        <DesktopRailItem
            icon={view.icon as React.ComponentProps<typeof Ionicons>['name']}
            key={`${view.pluginId}:${view.viewId}`}
            label={resolvePluginText(view.contribution.title)}
            onPress={() => onNavigate(view.path!)}
            testID={`sidebar-plugin-${view.pluginId}-button`}
        />
    ) : null);
}

export const SidebarView = React.memo(({
    closeDrawerOnNavigate = true,
    desktopDensity = false,
    desktopPrimaryNavigation = false,
}: SidebarViewProps) => {
    useDrawerHaptics();
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const navigation = useNavigation();
    const realtimeStatus = useRealtimeStatus();
    const friendRequests = useFriendRequests();
    const profile = useProfile();
    const agents = useLocalSetting('agents');
    const [desktopSidebarMode, setDesktopSidebarMode] = useLocalSettingMutable('desktopSidebarMode');
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const [pluginMarketplaceOpen, setPluginMarketplaceOpen] = React.useState(false);
    const [initialPluginId, setInitialPluginId] = React.useState<string | null>(null);
    const [footerMenu, setFooterMenu] = React.useState<FooterMenu>(null);
    const { agent: spaceAgent, exit: exitSpace } = useAgentSpace();
    const commandPaletteLauncher = useCommandPaletteLauncher();
    const { openSettings } = useDesktopSettingsModal();
    const displayName = getDisplayName(profile) ?? t('settings.title');

    React.useEffect(() => {
        if (!desktopDensity) {
            setFooterMenu((current) => current === 'help' ? null : current);
        }
    }, [desktopDensity]);

    const closeDrawer = React.useCallback(() => {
        if (!closeDrawerOnNavigate) {
            return;
        }
        navigation.dispatch(DrawerActions.closeDrawer());
    }, [closeDrawerOnNavigate, navigation]);

    // Navigate, closing the drawer first. On phone the drawer is a `front` overlay
    // that would otherwise stay open on top of the pushed screen; on desktop the
    // drawer is permanent, so SidebarNavigator disables the close action.
    const go = React.useCallback((path: string) => {
        closeDrawer();
        router.navigate(path as any);
    }, [closeDrawer, router]);

    const exitAgentSpace = React.useCallback(() => {
        exitSpace();
        go('/');
    }, [exitSpace, go]);

    const openSessionSearch = React.useCallback(() => {
        if (commandPaletteLauncher?.isAvailable) {
            closeDrawer();
            commandPaletteLauncher.open();
            return;
        }
        go('/session/search');
    }, [closeDrawer, commandPaletteLauncher, go]);

    const setAccountMenuOpen = React.useCallback((open: boolean) => {
        setFooterMenu(open ? 'account' : null);
    }, []);

    const setHelpMenuOpen = React.useCallback((open: boolean) => {
        setFooterMenu(open ? 'help' : null);
    }, []);

    const openPluginMarketplace = React.useCallback(() => {
        setSheetOpen(false);
        setInitialPluginId(null);
        setPluginMarketplaceOpen(true);
    }, []);

    const closePluginMarketplace = React.useCallback(() => {
        setPluginMarketplaceOpen(false);
        setInitialPluginId(null);
    }, []);

    // 「Agent 空间模式」：进入某个 Agent 后，整个侧栏收敛为该 Agent 的专属工作台，
    // 隐藏全局用户卡/收件箱/会话列表，只看本空间。退出空间即回落到下面的常规侧栏。
    if (spaceAgent) {
        return (
            <View style={[
                styles.container,
                desktopDensity && styles.containerDesktop,
                { paddingTop: safeArea.top + (desktopDensity ? 4 : 12) },
            ]}>
                <AgentSpaceWorkbench
                    agent={spaceAgent}
                    onExit={exitAgentSpace}
                    onNavigate={go}
                    onCloseDrawer={closeDrawer}
                />
            </View>
        );
    }

    const primaryNavigation = (
        <View style={styles.primaryNavigation} testID="sidebar-primary-navigation">
                <Pressable
                    onPress={() => go('/new')}
                    testID="sidebar-new-session-button"
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        desktopDensity && styles.newSessionButtonDesktop,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                >
                    <Ionicons name="create-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('sidebar.newSession')}</Text>
                </Pressable>

                <Pressable
                    onPress={() => go('/inbox')}
                    testID="sidebar-inbox-button"
                    style={[styles.messagesRow, desktopDensity && styles.messagesRowDesktop]}
                >
                    <Ionicons name="chatbubble-ellipses-outline" size={17} color={stylesheet.messagesText.color} />
                    <Text style={styles.messagesText}>{t('tabs.inbox')}</Text>
                    {friendRequests.length > 0 && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>{friendRequests.length}</Text>
                        </View>
                    )}
                </Pressable>

                <Pressable
                    onPress={openSessionSearch}
                    testID="sidebar-command-palette-button"
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        desktopDensity && styles.newSessionButtonDesktop,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                >
                    <Ionicons name="search-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('sidebar.searchSessions')}</Text>
                </Pressable>

                <Pressable
                    accessibilityRole="button"
                    onPress={openPluginMarketplace}
                    testID="sidebar-plugins-button"
                    style={({ pressed }) => [
                        styles.pluginsButton,
                        desktopDensity && styles.pluginsButtonDesktop,
                        pressed && styles.agentsCardPressed,
                    ]}
                >
                    <Ionicons name="extension-puzzle-outline" size={16} color={stylesheet.pluginsText.color} />
                    <Text style={styles.pluginsText}>{t('relationshipAdvisorPlugin.marketTitle')}</Text>
                    <Ionicons name="chevron-forward" size={15} color={stylesheet.pluginsChevron.color} />
                </Pressable>
        </View>
    );

    const agentAndHistoryNavigation = (
        <View style={styles.secondaryNavigation} testID="sidebar-secondary-navigation">
                <View
                    style={styles.secondaryNavigationDivider}
                    testID="sidebar-secondary-navigation-divider"
                />
                {/* My Agents remains available, while its add action is a compact
                    secondary affordance instead of another primary navigation row. */}
                <Pressable
                    onPress={() => setSheetOpen(true)}
                    testID="sidebar-my-agents-button"
                    style={({ pressed }) => [
                        styles.agentsCard,
                        desktopDensity && styles.agentsCardDesktop,
                        pressed && styles.agentsCardPressed,
                    ]}
                >
                    <View style={styles.agentsHeader}>
                        <Text style={styles.agentsTitle} numberOfLines={1}>{t('agents.cardTitle')}</Text>
                        <Pressable
                            accessibilityLabel={t('agents.add')}
                            accessibilityRole="button"
                            onPress={(e) => { e.stopPropagation(); go('/settings/my-agents'); }}
                            hitSlop={8}
                            style={({ pressed }) => [styles.agentsAdd, pressed && styles.agentsAddPressed]}
                            testID="sidebar-add-agent-button"
                        >
                            <Ionicons name="add" size={16} color={stylesheet.agentsAddText.color} />
                            {!desktopDensity ? (
                                <Text style={styles.agentsAddText}>{t('agents.add')}</Text>
                            ) : null}
                        </Pressable>
                    </View>
                    {!desktopDensity && agents.length > 0 ? (
                        <View style={styles.agentsAvatars}>
                            {agents.slice(0, 5).map((agent) => (
                                <View key={agent.id} style={[styles.agentMiniAvatar, { backgroundColor: agent.color }]}>
                                    <Text style={styles.agentMiniGlyph}>{agent.glyph}</Text>
                                </View>
                            ))}
                        </View>
                    ) : !desktopDensity ? (
                        <Text style={styles.agentsEmpty} numberOfLines={1}>{t('agents.empty')}</Text>
                    ) : null}
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: desktopPrimaryNavigation && desktopSidebarMode === 'history' }}
                    onPress={() => desktopPrimaryNavigation ? setDesktopSidebarMode('history') : go('/session/recent')}
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        desktopDensity && styles.newSessionButtonDesktop,
                        desktopPrimaryNavigation && desktopSidebarMode === 'history' && styles.navigationRowSelected,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                    testID="sidebar-history-button"
                >
                    <Ionicons name="time-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('relationshipAdvisor.historyTitle')}</Text>
                </Pressable>
        </View>
    );

    const desktopNavigationRail = (
        <View style={styles.desktopRail} testID="desktop-navigation-rail">
            <DesktopRailItem
                icon="create-outline"
                label={t('sidebar.newSession')}
                onPress={() => go('/new')}
                testID="sidebar-new-session-button"
            />
            <DesktopRailItem
                badge={friendRequests.length}
                icon="chatbubble-ellipses-outline"
                label={t('tabs.inbox')}
                onPress={() => go('/inbox')}
                testID="sidebar-inbox-button"
            />
            <DesktopRailItem
                icon="search-outline"
                label={t('sidebar.searchSessions')}
                onPress={openSessionSearch}
                testID="sidebar-command-palette-button"
            />
            <View style={styles.desktopRailDivider} />
            <DesktopRailItem
                icon="extension-puzzle-outline"
                label={t('relationshipAdvisorPlugin.marketTitle')}
                onPress={openPluginMarketplace}
                testID="sidebar-plugins-button"
            />
            <DesktopPluginRailItems onNavigate={go} />
            <DesktopRailItem
                icon="people-outline"
                label={t('agents.cardTitle')}
                onPress={() => setSheetOpen(true)}
                testID="sidebar-my-agents-button"
            />
            <DesktopRailItem
                icon="time-outline"
                label={t('relationshipAdvisor.historyTitle')}
                onPress={() => setDesktopSidebarMode('history')}
                selected={desktopSidebarMode === 'history'}
                testID="sidebar-history-button"
            />
        </View>
    );

    const pluginNavigation = (
        <PluginLeftSidebarSlot desktopDensity={desktopDensity} onNavigate={go} />
    );

    const voiceStatus = realtimeStatus !== 'disconnected'
        ? <VoiceAssistantStatusBar variant="sidebar" />
        : null;

    const footerNavigation = (
        <View
                style={[
                    styles.footerMenuSlot,
                    desktopDensity && styles.footerMenusDesktop,
                    desktopPrimaryNavigation && styles.footerMenusRail,
                    { paddingBottom: safeArea.bottom },
                ]}
                testID={desktopDensity ? 'sidebar-footer-menus' : undefined}
            >
                {desktopDensity ? (
                    <View style={styles.accountMenuSlot} testID="sidebar-account-menu-slot">
                        <SidebarAccountMenu
                            desktopDensity
                            railMode={desktopPrimaryNavigation}
                            displayName={displayName}
                            onNavigate={go}
                            onOpenSettings={openSettings}
                            onOpenChange={setAccountMenuOpen}
                            open={footerMenu === 'account'}
                            profile={profile}
                            restoreFocusOnClose={footerMenu !== 'help'}
                            unreadCount={friendRequests.length}
                        />
                    </View>
                ) : (
                    <SidebarAccountMenu
                        desktopDensity={desktopDensity}
                        displayName={displayName}
                        onNavigate={go}
                        onOpenSettings={openSettings}
                        onOpenChange={setAccountMenuOpen}
                        open={footerMenu === 'account'}
                        profile={profile}
                        unreadCount={friendRequests.length}
                    />
                )}
                {desktopDensity ? (
                    <SidebarHelpMenu
                        railMode={desktopPrimaryNavigation}
                        onOpenChange={setHelpMenuOpen}
                        open={footerMenu === 'help'}
                        restoreFocusOnClose={footerMenu !== 'account'}
                    />
                ) : null}
        </View>
    );

    const overlays = (
        <>
            <AgentSheet
                visible={sheetOpen}
                onClose={() => setSheetOpen(false)}
            />
            <PluginMarketplaceModal
                initialPluginId={initialPluginId}
                onClose={closePluginMarketplace}
                visible={pluginMarketplaceOpen}
            />
        </>
    );

    return (
        <View
            style={[
                styles.container,
                desktopDensity && styles.containerDesktop,
                { paddingTop: safeArea.top + (desktopDensity ? 4 : 12) },
            ]}
            testID={desktopDensity ? 'sidebar-desktop-density' : undefined}
        >
            {footerMenu !== null ? (
                <Pressable
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    onPress={() => setFooterMenu(null)}
                    style={styles.footerMenuDismissLayer}
                    testID="sidebar-footer-menu-dismiss-layer"
                />
            ) : null}

            {desktopPrimaryNavigation ? (
                <>
                    <View style={styles.desktopPrimaryColumn} testID="desktop-primary-navigation-column">
                        {desktopNavigationRail}
                        <View style={styles.desktopPrimarySpacer} />
                        {footerNavigation}
                    </View>
                    <View style={styles.desktopSecondaryColumn} testID="desktop-secondary-navigation-column">
                        <DesktopSidebarSessionsNavigation />
                    </View>
                </>
            ) : (
                <>
                    {primaryNavigation}
                    {agentAndHistoryNavigation}
                    {pluginNavigation}
                    {voiceStatus}
                    <DesktopSidebarSessionsNavigation />
                    {footerNavigation}
                </>
            )}
            {overlays}
        </View>
    );
});
