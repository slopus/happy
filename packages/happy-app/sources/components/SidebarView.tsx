import * as React from 'react';
import { Text, View, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useNavigation, usePathname } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useProfile, useLocalSettingMutable } from '@/sync/storage';
import { getDisplayName } from '@/sync/profile';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useDrawerHaptics } from './useDrawerHaptics';
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
    mobilePrimaryColumn: {
        width: 56,
        paddingBottom: 4,
    },
    mobileRailScroll: { flex: 1, minHeight: 0 },
    mobileRailButton: { width: 48, minHeight: 56, height: undefined, gap: 4, paddingVertical: 6 },
    mobileRailLabel: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        textAlign: 'center',
        width: 48,
        ...Typography.default(),
    },
    mobileHeader: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        minHeight: 52, paddingHorizontal: 8,
    },
    mobileHeaderTitle: { flex: 1, fontSize: 17, color: theme.colors.text, ...Typography.default('semiBold') },
    mobileHeaderButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    mobileContent: { flex: 1, minHeight: 0 },
    hiddenContent: { display: 'none' },
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
    newSessionIcon: {
        color: theme.colors.status.connected,
    },
    newSessionGlyph: {
        alignItems: 'center',
        backgroundColor: theme.colors.status.connected,
        borderRadius: 5,
        height: 22,
        justifyContent: 'center',
        width: 22,
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
    navigationCardPressed: {
        backgroundColor: theme.colors.surfacePressed,
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
    onCloseDrawer?: () => void;
    closeDrawerOnNavigate?: boolean;
    desktopDensity?: boolean;
    desktopPrimaryNavigation?: boolean;
}

type FooterMenu = 'account' | 'help' | null;

function NewSessionGlyph() {
    return (
        <View style={stylesheet.newSessionGlyph} testID="sidebar-new-session-glyph">
            <Ionicons
                color="#FFFFFF"
                dataSet={{ iconName: 'add' }}
                name="add"
                size={20}
                testID="sidebar-new-session-icon"
            />
        </View>
    );
}

function DesktopRailItem({
    icon,
    iconColor,
    label,
    onPress,
    selected = false,
    testID,
    showLabel = false,
}: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    label: string;
    onPress: () => void;
    selected?: boolean;
    testID: string;
    showLabel?: boolean;
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
                    showLabel && styles.mobileRailButton,
                    selected && styles.desktopRailButtonSelected,
                    (active || pressed) && styles.desktopRailButtonActive,
                ]}
                testID={testID}
            >
                {testID === 'sidebar-new-session-button' ? (
                    <NewSessionGlyph />
                ) : (
                    <Ionicons
                        color={iconColor ?? (selected ? stylesheet.newSessionText.color : stylesheet.pluginsChevron.color)}
                        name={icon}
                        size={21}
                    />
                )}
                {showLabel ? <Text numberOfLines={2} style={styles.mobileRailLabel}>{label}</Text> : null}
            </Pressable>
            {active && !showLabel ? (
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

function DesktopPluginRailItems({ onNavigate, showLabels = false, selectedPath }: { onNavigate: (path: string) => void; showLabels?: boolean; selectedPath?: string | null }) {
    const views = usePluginSurfaceViews('left-sidebar');
    const pathname = usePathname();

    return views.map((view) => view.path ? (
        <DesktopRailItem
            showLabel={showLabels}
            icon={view.icon as React.ComponentProps<typeof Ionicons>['name']}
            key={`${view.pluginId}:${view.viewId}`}
            label={showLabels && view.pluginId === 'relationship-advisor' ? t('relationshipAdvisor.title') : resolvePluginText(view.contribution.title)}
            onPress={() => onNavigate(view.path!)}
            selected={(selectedPath === undefined ? pathname : selectedPath) === view.path}
            testID={`sidebar-plugin-${view.pluginId}-button`}
        />
    ) : null);
}

export const SidebarView = React.memo(({
    onCloseDrawer,
    closeDrawerOnNavigate = true,
    desktopDensity = false,
    desktopPrimaryNavigation = false,
}: SidebarViewProps) => {
    useDrawerHaptics();
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const pathname = usePathname();
    const mobileNavigation = !desktopDensity;
    const railNavigation = desktopPrimaryNavigation || mobileNavigation;
    const [mobilePanel, setMobilePanel] = React.useState<'sessions' | 'advisor'>(pathname === '/relationship-advisor' ? 'advisor' : 'sessions');
    React.useEffect(() => {
        setMobilePanel(pathname === '/relationship-advisor' ? 'advisor' : 'sessions');
    }, [pathname]);
    const advisorSidebarActive = railNavigation && (mobileNavigation ? mobilePanel === 'advisor' : pathname === '/relationship-advisor');
    const navigation = useNavigation();
    const realtimeStatus = useRealtimeStatus();
    const profile = useProfile();
    const [desktopSidebarMode, setDesktopSidebarMode] = useLocalSettingMutable('desktopSidebarMode');
    const [desktopSidebarListMode] = useLocalSettingMutable('desktopSidebarListMode');
    const [pluginMarketplaceOpen, setPluginMarketplaceOpen] = React.useState(false);
    const [initialPluginId, setInitialPluginId] = React.useState<string | null>(null);
    const [footerMenu, setFooterMenu] = React.useState<FooterMenu>(null);
    const commandPaletteLauncher = useCommandPaletteLauncher();
    const { isDesktop, openSettings, openActivity, openRoute } = useDesktopSettingsModal();
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
        if (onCloseDrawer) onCloseDrawer();
        else navigation.dispatch(DrawerActions.closeDrawer());
    }, [closeDrawerOnNavigate, navigation, onCloseDrawer]);

    // Navigate, closing the drawer first. On phone the drawer is a `front` overlay
    // that would otherwise stay open on top of the pushed screen; on desktop the
    // drawer is permanent, so SidebarNavigator disables the close action.
    const go = React.useCallback((path: string) => {
        closeDrawer();
        router.navigate(path as any);
    }, [closeDrawer, router]);

    const openDesktopSessionLists = () => {
        setDesktopSidebarMode(desktopSidebarListMode);
        if (mobileNavigation) setMobilePanel('sessions');
        else if (advisorSidebarActive) go('/');
    };

    const openArchive = () => {
        setDesktopSidebarMode('archive');
        if (mobileNavigation) setMobilePanel('sessions');
    };

    const openSettingsFromSidebar = React.useCallback(() => {
        if (isDesktop) {
            openSettings();
            return;
        }
        go('/settings');
    }, [go, isDesktop, openSettings]);

    const openAccountManagement = React.useCallback((add = false) => {
        if (isDesktop) {
            openRoute('/accounts', add ? { add: '1' } : undefined);
            return;
        }
        go(add ? '/accounts?add=1' : '/accounts');
    }, [go, isDesktop, openRoute]);

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
        setInitialPluginId(null);
        setPluginMarketplaceOpen(true);
    }, []);

    const closePluginMarketplace = React.useCallback(() => {
        setPluginMarketplaceOpen(false);
        setInitialPluginId(null);
    }, []);

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
                    <NewSessionGlyph />
                    <Text style={styles.newSessionText}>{t('sidebar.newSession')}</Text>
                </Pressable>

                <Pressable
                    onPress={() => { closeDrawer(); openActivity(); }}
                    testID="sidebar-inbox-button"
                    style={[styles.messagesRow, desktopDensity && styles.messagesRowDesktop]}
                >
                    <Ionicons name="chatbubble-ellipses-outline" size={17} color={stylesheet.messagesText.color} />
                    <Text style={styles.messagesText}>{t('tabs.inbox')}</Text>
                </Pressable>

                <Pressable accessibilityRole="button" onPress={() => go('/agent-profiles')} testID="sidebar-party-agents-button" style={({ pressed }) => [styles.messagesRow, desktopDensity && styles.messagesRowDesktop, pressed && styles.navigationCardPressed]}>
                    <Ionicons name="person-add-outline" size={17} color={stylesheet.messagesText.color}/><Text style={styles.messagesText}>群聊 Agent 管理</Text>
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
                        pressed && styles.navigationCardPressed,
                    ]}
                >
                    <Ionicons name="extension-puzzle-outline" size={16} color={stylesheet.pluginsText.color} />
                    <Text style={styles.pluginsText}>{t('relationshipAdvisorPlugin.marketTitle')}</Text>
                    <Ionicons name="chevron-forward" size={15} color={stylesheet.pluginsChevron.color} />
                </Pressable>
        </View>
    );

    const archiveNavigation = (
        <View style={styles.secondaryNavigation} testID="sidebar-secondary-navigation">
                <View
                    style={styles.secondaryNavigationDivider}
                    testID="sidebar-secondary-navigation-divider"
                />
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: desktopPrimaryNavigation && desktopSidebarMode === 'archive' }}
                    onPress={() => desktopPrimaryNavigation ? setDesktopSidebarMode('archive') : go('/session/recent')}
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        desktopDensity && styles.newSessionButtonDesktop,
                        desktopPrimaryNavigation && desktopSidebarMode === 'archive' && styles.navigationRowSelected,
                        pressed && styles.newSessionButtonPressed,
                    ]}
                    testID="sidebar-archive-button"
                >
                    <Ionicons name="archive-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('sessionHistory.archiveTitle')}</Text>
                </Pressable>
        </View>
    );

    const desktopNavigationRail = (
        <View style={styles.desktopRail} testID="desktop-navigation-rail">
            <DesktopRailItem
                icon="add"
                iconColor={stylesheet.newSessionIcon.color}
                label={t('sidebar.newSession')}
                onPress={() => go('/new')}
                testID="sidebar-new-session-button"
            />
            <DesktopRailItem
                icon="chatbubble-ellipses-outline"
                label={t('tabs.inbox')}
                onPress={() => { closeDrawer(); openActivity(); }}
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
            <DesktopPluginRailItems selectedPath={mobileNavigation ? (advisorSidebarActive ? '/relationship-advisor' : null) : undefined} onNavigate={(path) => {
                if (mobileNavigation && path === '/relationship-advisor') {
                    setMobilePanel('advisor');
                    return;
                }
                go(path);
            }} />
            <DesktopRailItem
                icon="albums-outline"
                label={t('sidebar.listsTab')}
                onPress={openDesktopSessionLists}
                selected={!advisorSidebarActive && desktopSidebarMode !== 'archive'}
                testID="sidebar-session-list-button"
            />
            <DesktopRailItem
                icon="file-tray-stacked-outline"
                label={t('sessionHistory.archiveTitle')}
                onPress={openArchive}
                selected={!advisorSidebarActive && desktopSidebarMode === 'archive'}
                testID="sidebar-archive-button"
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
                    railNavigation && styles.footerMenusRail,
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
                            onOpenAccounts={openAccountManagement}
                            onOpenSettings={openSettingsFromSidebar}
                            onOpenChange={setAccountMenuOpen}
                            open={footerMenu === 'account'}
                            profile={profile}
                            restoreFocusOnClose={footerMenu !== 'help'}
                        />
                    </View>
                ) : (
                    <SidebarAccountMenu
                        desktopDensity={desktopDensity}
                        railMode={mobileNavigation}
                        mobileRail={mobileNavigation}
                        displayName={displayName}
                        onNavigate={go}
                        onOpenAccounts={openAccountManagement}
                        onOpenSettings={openSettingsFromSidebar}
                        onOpenChange={setAccountMenuOpen}
                        open={footerMenu === 'account'}
                        profile={profile}
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
                (desktopDensity || railNavigation) && styles.containerDesktop,
                { paddingTop: safeArea.top + (desktopDensity ? 4 : 12) },
            ]}
            testID={desktopDensity ? 'sidebar-desktop-density' : 'sidebar-mobile-rail-layout'}
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

            {railNavigation ? (
                <>
                    <View style={mobileNavigation ? [styles.desktopPrimaryColumn, styles.mobilePrimaryColumn] : styles.desktopPrimaryColumn} testID={mobileNavigation ? 'mobile-primary-navigation-column' : 'desktop-primary-navigation-column'}>
                        {mobileNavigation ? (
                            <ScrollView style={styles.mobileRailScroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
                                {desktopNavigationRail}
                            </ScrollView>
                        ) : <>{desktopNavigationRail}<View style={styles.desktopPrimarySpacer} /></>}
                        {footerNavigation}
                    </View>
                    <View style={styles.desktopSecondaryColumn} testID="desktop-secondary-navigation-column">
                        {mobileNavigation ? (
                            <>
                                <View style={styles.mobileHeader}>
                                    {advisorSidebarActive ? (
                                        <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => setMobilePanel('sessions')} style={styles.mobileHeaderButton} testID="mobile-sidebar-back-to-sessions">
                                            <Ionicons name="chevron-back" size={20} color={styles.mobileHeaderTitle.color} />
                                        </Pressable>
                                    ) : null}
                                    <Text style={styles.mobileHeaderTitle} numberOfLines={1}>
                                        {advisorSidebarActive
                                            ? t('relationshipAdvisor.title')
                                            : desktopSidebarMode === 'archive'
                                                ? t('sessionHistory.archiveTitle')
                                                : t('tabs.sessions')}
                                    </Text>
                                    <Pressable accessibilityRole="button" accessibilityLabel={t('sidebarLists.close')} onPress={closeDrawer} style={styles.mobileHeaderButton} testID="mobile-sidebar-close">
                                        <Ionicons name="close" size={20} color={styles.mobileHeaderTitle.color} />
                                    </Pressable>
                                </View>
                                <View style={[styles.mobileContent, advisorSidebarActive && styles.hiddenContent]} accessibilityElementsHidden={advisorSidebarActive} importantForAccessibility={advisorSidebarActive ? 'no-hide-descendants' : 'auto'}>
                                    <DesktopSidebarSessionsNavigation />
                                </View>
                                {advisorSidebarActive ? <PluginLeftSidebarSlot desktopDensity fillAvailableSpace onNavigate={go} /> : null}
                            </>
                        ) : advisorSidebarActive ? (
                            <PluginLeftSidebarSlot desktopDensity={desktopDensity} fillAvailableSpace onNavigate={go} />
                        ) : (
                            <DesktopSidebarSessionsNavigation />
                        )}
                    </View>
                </>
            ) : (
                <>
                    {primaryNavigation}
                    {archiveNavigation}
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
