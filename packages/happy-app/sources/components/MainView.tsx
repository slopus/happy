import * as React from 'react';
import { View, ActivityIndicator, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFriendRequests, useSocketStatus, useRealtimeStatus } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/responsive';
import { useRouter } from 'expo-router';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { SessionsList } from './SessionsList';
import { FABWide } from './FABWide';
import { TabBar, TabType } from './TabBar';
import { InboxView } from './InboxView';
import { SettingsViewWrapper } from './SettingsViewWrapper';
import { SessionsListWrapper } from './SessionsListWrapper';
import { Header } from './navigation/Header';
import { HeaderLogo } from './HeaderLogo';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { StatusDot } from './StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { trackFriendsSearch } from '@/track';

interface MainViewProps {
    variant: 'phone' | 'sidebar';
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    phoneContainer: {
        flex: 1,
    },
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    tabletLoadingContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.groupped.background,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickSessionContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
        backgroundColor: theme.colors.groupped.background,
    },
    pickSessionIcon: {
        marginBottom: 16,
        opacity: 0.5,
    },
    pickSessionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

// Tab header configuration
const TAB_TITLES = {
    sessions: 'tabs.sessions',
    inbox: 'tabs.inbox',
    settings: 'tabs.settings',
} as const;

// Active tabs
type ActiveTabType = 'sessions' | 'inbox' | 'settings';

// Header title component with connection status
const HeaderTitle = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();

    const connectionStatus = React.useMemo(() => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    isPulsing: false,
                    text: t('status.connected'),
                };
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    isPulsing: true,
                    text: t('status.connecting'),
                };
            case 'disconnected':
                return {
                    color: theme.colors.status.disconnected,
                    isPulsing: false,
                    text: t('status.disconnected'),
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    isPulsing: false,
                    text: t('status.error'),
                };
            default:
                return {
                    color: theme.colors.status.default,
                    isPulsing: false,
                    text: '',
                };
        }
    }, [socketStatus, theme]);

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {t(TAB_TITLES[activeTab])}
            </Text>
            {connectionStatus.text && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={[styles.statusText, { color: connectionStatus.color }]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
});

// Header right button - varies by tab
const HeaderRight = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const isCustomServer = isUsingCustomServer();

    if (activeTab === 'sessions') {
        return (
            <Pressable
                onPress={() => router.navigate('/new')}
                hitSlop={15}
                style={styles.headerButton}
            >
                <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
            </Pressable>
        );
    }

    if (activeTab === 'inbox') {
        return (
            <Pressable
                onPress={() => {
                    trackFriendsSearch();
                    router.push('/friends/search');
                }}
                hitSlop={15}
                style={styles.headerButton}
            >
                <Ionicons name="person-add-outline" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }

    if (activeTab === 'settings') {
        if (!isCustomServer) {
            // Empty view to maintain header centering
            return <View style={styles.headerButton} />;
        }
        return (
            <Pressable
                onPress={() => router.push('/server')}
                hitSlop={15}
                style={styles.headerButton}
            >
                <Ionicons name="server-outline" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }

    return null;
});

const TabletPickSessionPlaceholder = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={styles.pickSessionContainer}>
            <Ionicons
                name="terminal-outline"
                size={56}
                color={theme.colors.textSecondary}
                style={styles.pickSessionIcon}
            />
            <Text style={styles.pickSessionText}>
                Select a session from the sidebar.
            </Text>
        </View>
    );
});

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const isTablet = useIsTablet();
    const router = useRouter();
    const friendRequests = useFriendRequests();
    const realtimeStatus = useRealtimeStatus();

    // Tab state management
    // NOTE: Zen tab removed - the feature never got to a useful state
    const [activeTab, setActiveTab] = React.useState<TabType>('sessions');

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new');
    }, [router]);

    const handleTabPress = React.useCallback((tab: TabType) => {
        setActiveTab(tab);
    }, []);

    // Regular phone mode with tabs - define this before any conditional returns
    const renderTabContent = React.useCallback(() => {
        switch (activeTab) {
            case 'inbox':
                return <InboxView />;
            case 'settings':
                return <SettingsViewWrapper />;
            case 'sessions':
            default:
                return <SessionsListWrapper />;
        }
    }, [activeTab]);

    // Sidebar variant
    if (variant === 'sidebar') {
        // Loading state
        if (sessionListViewData === null) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            );
        }

        // Empty state
        if (sessionListViewData.length === 0) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        <EmptySessionsTablet />
                    </View>
                </View>
            );
        }

        // Sessions list
        return (
            <View style={styles.sidebarContentContainer}>
                <SessionsList />
            </View>
        );
    }

    // Phone variant
    // Tablet in phone mode: with the sidebar showing the session list on the
    // left, the right pane on the index route used to render a bare empty
    // View. On a wide window that read as "the whole app went blank" — users
    // perceived nothing on screen even though the sidebar had content. Show
    // a placeholder that mirrors the sidebar's empty state when there are no
    // sessions yet, and a clear "pick a session" hint otherwise.
    if (isTablet) {
        return (
            <View style={styles.emptyStateContentContainer}>
                {sessionListViewData === null ? (
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : sessionListViewData.length === 0 ? (
                    <EmptySessionsTablet />
                ) : (
                    <TabletPickSessionPlaceholder />
                )}
            </View>
        );
    }

    // Regular phone mode with tabs
    return (
        <>
            <View style={styles.phoneContainer}>
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={<HeaderTitle activeTab={activeTab as ActiveTabType} />}
                        headerRight={() => <HeaderRight activeTab={activeTab as ActiveTabType} />}
                        headerLeft={() => <HeaderLogo />}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                    {realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
                {renderTabContent()}
            </View>
            <TabBar
                activeTab={activeTab}
                onTabPress={handleTabPress}
                inboxBadgeCount={friendRequests.length}
            />
        </>
    );
});
