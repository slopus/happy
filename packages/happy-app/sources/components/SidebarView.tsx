import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useNavigation } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useFriendRequests, useProfile, useLocalSetting } from '@/sync/storage';
import { getDisplayName } from '@/sync/profile';
import { MainView } from './MainView';
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
import { RelationshipAdvisorSidebarHistory } from './relationship-advisor/RelationshipAdvisorSidebarHistory';
import { useDesktopSettingsModal } from './DesktopSettingsModal';

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
}

type FooterMenu = 'account' | 'help' | null;

export const SidebarView = React.memo(({
    closeDrawerOnNavigate = true,
    desktopDensity = false,
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
    const [sheetOpen, setSheetOpen] = React.useState(false);
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

            {/* Stable primary work navigation. Keep these entries contiguous so
                machines, Agents, and sessions remain context rather than peers. */}
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
            </View>

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
            </View>

            <RelationshipAdvisorSidebarHistory
                desktopDensity={desktopDensity}
                onNavigate={go}
            />

            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="sidebar" />
            )}

            {/* Sessions list */}
            <MainView variant="sidebar" />

            {/* Low-frequency account and system actions stay anchored below the work list. */}
            <View
                style={[
                    styles.footerMenuSlot,
                    desktopDensity && styles.footerMenusDesktop,
                    { paddingBottom: safeArea.bottom },
                ]}
                testID={desktopDensity ? 'sidebar-footer-menus' : undefined}
            >
                {desktopDensity ? (
                    <View style={styles.accountMenuSlot} testID="sidebar-account-menu-slot">
                        <SidebarAccountMenu
                            desktopDensity
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
                        onOpenChange={setHelpMenuOpen}
                        open={footerMenu === 'help'}
                        restoreFocusOnClose={footerMenu !== 'account'}
                    />
                ) : null}
            </View>

            {/* Bottom drawer listing the user's agents (RN Modal — placement in tree is irrelevant) */}
            <AgentSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
        </View>
    );
});
