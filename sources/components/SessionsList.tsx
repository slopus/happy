import React from 'react';
import { View, Pressable, FlatList, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroup } from './ActiveSessionsGroup';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    headerText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    archivedContainer: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 8,
    },
    archivedSectionHeader: {
        paddingTop: Platform.select({ ios: 20, default: 16 }),
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    archivedSectionHeaderText: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    archivedSessionsCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 12,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
}));

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const navigateToSession = useNavigateToSession();
    const selectable = isTablet;
    const dataWithSelected = selectable ? React.useMemo(() => {
        return data?.map(item => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`)
        }));
    }, [data, pathname]) : data;

    // Request review
    React.useEffect(() => {
        if (data && data.length > 0) {
            requestReview();
        }
    }, [data && data.length > 0]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem & { selected?: boolean }, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem & { selected?: boolean } }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'active-sessions':
                // Extract just the session ID from pathname (e.g., /session/abc123/file -> abc123)
                let selectedId: string | undefined;
                if (isTablet && pathname.startsWith('/session/')) {
                    const parts = pathname.split('/');
                    selectedId = parts[2]; // parts[0] is empty, parts[1] is 'session', parts[2] is the ID
                }
                return (
                    <ActiveSessionsGroup
                        sessions={item.sessions}
                        selectedSessionId={selectedId}
                    />
                );

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>
                            {item.displayPath}
                        </Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

            case 'session':
                return (
                    <SessionItem session={item.session} selected={item.selected} />
                );
        }
    }, [pathname]);

    // ItemSeparatorComponent for FlashList
    const ItemSeparatorComponent = React.useCallback(({ leadingItem, trailingItem }: any) => {
        // Don't render separator if either item is a header
        if (leadingItem?.type === 'header' || trailingItem?.type === 'header' || leadingItem?.type === 'active-sessions' || trailingItem?.type === 'active-sessions') {
            return null;
        }

        // Use standard indentation for separators
        const marginLeft = 88;

        return <View style={styles.separator} />;
    }, []);

    // Group archived sessions in a card
    const renderContent = React.useMemo(() => {
        if (!dataWithSelected) return [];

        const result: React.ReactElement[] = [];
        let archivedItems: (SessionListViewItem & { selected?: boolean })[] = [];
        let isCollectingArchived = false;

        dataWithSelected.forEach((item, index) => {
            if (item.type === 'header' && item.title === 'Previous Sessions') {
                // Skip rendering the header, just start collecting archived items
                isCollectingArchived = true;
            } else if (item.type === 'header' || item.type === 'active-sessions') {
                // Render non-archived items directly
                if (item.type === 'active-sessions') {
                    let selectedId: string | undefined;
                    if (isTablet && pathname.startsWith('/session/')) {
                        const parts = pathname.split('/');
                        selectedId = parts[2];
                    }
                    result.push(
                        <ActiveSessionsGroup
                            key="active-sessions"
                            sessions={item.sessions}
                            selectedSessionId={selectedId}
                        />
                    );
                } else {
                    result.push(
                        <View key={`header-${item.title}-${index}`} style={styles.headerSection}>
                            <Text style={styles.headerText}>
                                {item.title}
                            </Text>
                        </View>
                    );
                }
                isCollectingArchived = false;
            } else if (isCollectingArchived) {
                // Collect archived items
                archivedItems.push(item);
            }
        });

        // Render archived items in a card
        if (archivedItems.length > 0) {
            result.push(
                <View key="archived-container" style={styles.archivedContainer}>
                    {/* Section header for Archived Sessions */}
                    <View style={styles.archivedSectionHeader}>
                        <Text style={styles.archivedSectionHeaderText}>
                            Archived Sessions
                        </Text>
                    </View>

                    {/* Card with rounded corners containing archived sessions */}
                    <View style={styles.archivedSessionsCard}>
                        {archivedItems.map((item, index) => {
                            const showSeparator = index < archivedItems.length - 1 &&
                                !(item.type === 'project-group' && archivedItems[index + 1]?.type === 'session');

                            return (
                                <React.Fragment key={keyExtractor(item, index)}>
                                    {item.type === 'project-group' ? (
                                        <View style={styles.projectGroup}>
                                            <Text style={styles.projectGroupTitle}>
                                                {item.displayPath}
                                            </Text>
                                            <Text style={styles.projectGroupSubtitle}>
                                                {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                                            </Text>
                                        </View>
                                    ) : item.type === 'session' ? (
                                        <SessionItem session={item.session} selected={item.selected} />
                                    ) : null}
                                    {showSeparator && <View style={styles.separator} />}
                                </React.Fragment>
                            );
                        })}
                    </View>
                </View>
            );
        }

        return result;
    }, [dataWithSelected, isTablet, pathname, keyExtractor]);


    const HeaderComponent = React.useCallback(() => {
        return (
            <View style={{ marginHorizontal: -4 }}>
                <UpdateBanner />
            </View>
        );
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={renderContent}
                    renderItem={({ item }) => item}
                    keyExtractor={(_, index) => `item-${index}`}
                    contentContainerStyle={{ paddingBottom: safeArea.bottom + 16, maxWidth: layout.maxWidth }}
                    ListHeaderComponent={HeaderComponent}
                />
            </View>
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selected }: { session: Session; selected?: boolean }) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const navigateToSession = useNavigateToSession();

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    return (
        <Pressable
            style={[
                styles.sessionItem,
                selected && styles.sessionItemSelected
            ]}
            onPress={() => {
                navigateToSession(session.id);
            }}
        >
            <View style={styles.avatarContainer}>
                <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
                {session.draft && (
                    <View style={styles.draftIconContainer}>
                        <Ionicons
                            name="create-outline"
                            size={12}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                {/* Title line */}
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}> {/* {variant !== 'no-path' ? 1 : 2} - issue is we don't have anything to take this space yet and it looks strange - if summaries were more reliably generated, we can add this. While no summary - add something like "New session" or "Empty session", and extend summary to 2 lines once we have it */}
                        {sessionName}
                    </Text>
                </View>

                {/* Subtitle line */}
                <Text style={styles.sessionSubtitle} numberOfLines={1}>
                    {sessionSubtitle}
                </Text>

                {/* Status line with dot */}
                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                    <Text style={[
                        styles.statusText,
                        { color: sessionStatus.statusColor }
                    ]}>
                        {sessionStatus.statusText}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
});