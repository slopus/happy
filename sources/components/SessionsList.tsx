import React from 'react';
import { View, Pressable, FlatList } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname, useRouter } from 'expo-router';
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

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.listBackground,
    },
    headerSection: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 8,
        backgroundColor: theme.colors.listBackground,
    },
    headerText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.subtitleText,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.listBackground,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.titleText,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.subtitleText,
        marginTop: 2,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.cardBackground,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.pressedOverlay,
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
        color: theme.colors.titleText,
    },
    sessionTitleDisconnected: {
        color: theme.colors.subtitleText,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.subtitleText,
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
        height: 0.5,
        backgroundColor: theme.colors.divider,
        marginLeft: 88,
    },
    draftIcon: {
        marginLeft: 6,
        color: theme.colors.subtitleText,
    },
}));

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useSessionListViewData();
    const pathname = usePathname();
    const selectable = true; //Platform.OS === 'web';
    const dataWithSelected = selectable ? React.useMemo(() => {
        return data?.map(item => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`)
        }));
    }, [data, pathname]) : data;

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
                return (
                    <ActiveSessionsGroup 
                        sessions={item.sessions} 
                        selectedSessionId={pathname.startsWith('/session/') ? pathname.split('/session/')[1] : undefined}
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
        if (leadingItem?.type === 'header' || trailingItem?.type === 'header') {
            return null;
        }

        // Use standard indentation for separators
        const marginLeft = 88;

        return <View style={styles.separator} />;
    }, []);

    return (
        <View style={styles.container}>
            <FlatList
                data={dataWithSelected!}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 16 }}
                ItemSeparatorComponent={ItemSeparatorComponent}
            />
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selected }: { session: Session; selected?: boolean }) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const router = useRouter();

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
                router.push(`/session/${session.id}`);
            }}
        >
            <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
            <View style={styles.sessionContent}>
                {/* Title line */}
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}> {/* {variant !== 'no-path' ? 1 : 2} - issue is we don't have anything to take this space yet and it looks strange - if summaries were more reliably generated, we can add this. While no summary - add something like "New session" or "Empty session", and extend summary to 2 lines once we have it */}
                        {sessionName}
                    </Text>
                    {session.draft && (
                        <Ionicons
                            name="create-outline"
                            size={16}
                            style={styles.draftIcon}
                        />
                    )}
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