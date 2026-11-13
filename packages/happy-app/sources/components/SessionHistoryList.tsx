import { isPersonalAgentConversation } from '@/sync/personalAgent';
import * as React from 'react';
import { useSidebarScrollState } from './SidebarScrollState';
import { FlatList, Platform, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { EmptySessionsTablet, shouldShowSessionEmptyState } from '@/components/EmptySessionsTablet';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { buildSessionRowData, storage, type SessionRowData, useAllSessions, useIsDataReady } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { SessionHistoryScrollIntent } from './sessionHistoryScrollIntent';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';

type SessionHistoryListVariant = 'page' | 'sidebar';

type SessionHistoryItem =
    | { key: string; type: 'date-header'; date: string }
    | { key: string; type: 'session'; session: SessionRowData };

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.groupped.background },
    pageContainer: { alignItems: 'stretch', flexDirection: 'row', justifyContent: 'center' },
    pageContent: { flex: 1, maxWidth: 960 },
    sidebarContent: { flex: 1, minHeight: 0 },
    listContentPage: { paddingTop: 8 },
    listContentSidebar: { paddingHorizontal: 8, paddingTop: 4 },
    dateHeader: {
        backgroundColor: theme.colors.groupped.background,
        paddingBottom: 8,
        paddingHorizontal: 16,
        paddingTop: 18,
    },
    dateHeaderSidebar: { paddingBottom: 5, paddingHorizontal: 8, paddingTop: 12 },
    dateHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: 14,
        fontWeight: '600',
        letterSpacing: 0.1,
    },
    dateHeaderTextSidebar: { fontSize: 12 },
    sessionCard: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        flexDirection: 'row',
        marginBottom: 1,
        marginHorizontal: 16,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    sessionCardSidebar: {
        borderRadius: 8,
        marginBottom: 2,
        marginHorizontal: 0,
        minHeight: 52,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    sessionCardPressed: { backgroundColor: theme.colors.surfacePressed },
    sessionCardSelected: { backgroundColor: theme.colors.surfaceSelected },
    sessionCardFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
    sessionCardLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 12 },
    sessionCardSingle: { borderRadius: 12, marginBottom: 12 },
    sessionContent: { flex: 1, marginLeft: 16, minWidth: 0 },
    sessionContentSidebar: { marginLeft: 10 },
    sessionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '500',
        marginBottom: 2,
    },
    sessionTitleSidebar: { fontSize: 13 },
    sessionSubtitle: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 13 },
    sessionSubtitleSidebar: { fontSize: 11 },
}));

function formatDateHeader(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today.getTime() - sessionDate.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return t('sessionHistory.today');
    if (diffDays === 1) return t('sessionHistory.yesterday');
    return t('sessionHistory.daysAgo', { count: diffDays });
}

function groupSessionsByDate(sessions: SessionRowData[]): SessionHistoryItem[] {
    const items: SessionHistoryItem[] = [];
    let previousDateKey: string | null = null;
    for (const session of [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
        const date = new Date(session.updatedAt ?? 0);
        const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (dateKey !== previousDateKey) {
            items.push({ key: `date-${dateKey}`, type: 'date-header', date: formatDateHeader(date) });
            previousDateKey = dateKey;
        }
        items.push({ key: `session-${session.id}`, type: 'session', session });
    }
    return items;
}

export const SessionHistoryList = React.memo(function SessionHistoryList({
    variant = 'page',
}: {
    variant?: SessionHistoryListVariant;
}) {
    const styles = stylesheet;
    const scrollState = useSidebarScrollState<SessionHistoryItem>('history');
    const safeArea = useSafeAreaInsets();
    const allSessions = useAllSessions();
    const isDataReady = useIsDataReady();
    const pathname = usePathname();
    const sidebar = variant === 'sidebar';
    const groupedItems = React.useMemo(
        () => groupSessionsByDate((allSessions ?? [])
            .filter(isSessionArchived)
            .map((session) => buildSessionRowData(session))),
        [allSessions],
    );
    const showEmptyState = shouldShowSessionEmptyState(groupedItems.length);
    const scrollIntent = React.useMemo(() => new SessionHistoryScrollIntent(), [showEmptyState]);
    React.useEffect(() => {
        if (!isDataReady || (sidebar && pathname !== '/new' && pathname !== '/')) return;
        const timer = setTimeout(() => { void sync.sessionRouteBecameInteractive(); }, 0);
        return () => clearTimeout(timer);
    }, [isDataReady, pathname, sidebar]);
    const hasSessions = (allSessions?.length ?? 0) > 0;
    const hasArchivedSessions = groupedItems.length > 0;
    React.useEffect(() => {
        if (!isDataReady || !hasSessions || hasArchivedSessions) return;
        let cancelled = false;
        const loadUntilArchived = async () => {
            let hasMore = true;
            while (!cancelled && hasMore && !Object.values(storage.getState().sessions).some(session => !isPersonalAgentConversation(session) && isSessionArchived(session))) {
                hasMore = await sync.loadNextSessionHistoryPage();
            }
        };
        void loadUntilArchived();
        return () => { cancelled = true; };
    }, [hasArchivedSessions, hasSessions, isDataReady]);
    const loadNextHistoryPage = React.useCallback(() => {
        if (!scrollIntent.consumeAtEnd()) return;
        void sync.loadNextSessionHistoryPage();
    }, [scrollIntent]);

    const renderItem = React.useCallback(({ item }: { item: SessionHistoryItem }) => {
        if (item.type === 'date-header') {
            return (
                <View style={[styles.dateHeader, sidebar && styles.dateHeaderSidebar]}>
                    <Text style={[styles.dateHeaderText, sidebar && styles.dateHeaderTextSidebar]}>{item.date}</Text>
                </View>
            );
        }

        const { session } = item;
        const selected = pathname === `/session/${session.id}`;

        return (
            <View testID={`session-history-row-${session.id}`}>
                <CompactSessionRow selected={selected} session={session} showLocation />
            </View>
        );
    }, [pathname, styles]);

    const content = showEmptyState
        ? (
            <EmptySessionsTablet
                description={t('sessionHistory.archiveEmptyDescription')}
                icon="archive-outline"
                showNewSessionAction={false}
                title={t('sessionHistory.archiveEmpty')}
            />
        )
        : (
            <FlatList
                {...scrollState}
                windowSize={5}
                initialNumToRender={20}
                maxToRenderPerBatch={10}
                contentContainerStyle={[
                    sidebar ? styles.listContentSidebar : styles.listContentPage,
                    { paddingBottom: safeArea.bottom + 16 },
                ]}
                data={groupedItems}
                keyExtractor={(item) => item.key}
                onScroll={(event) => {
                    const userScroll = scrollState.onScroll(event);
                    if (Platform.OS === 'web' && userScroll) scrollIntent.noteWebScroll(event.nativeEvent.contentOffset.y);
                }}
                onScrollBeginDrag={() => { scrollState.onScrollBeginDrag(); scrollIntent.noteNativeDrag(); }}
                onEndReached={loadNextHistoryPage}
                onEndReachedThreshold={0.5}
                renderItem={renderItem}
            />
        );

    return (
        <View
            style={[styles.container, !sidebar && styles.pageContainer]}
            testID={sidebar ? 'desktop-sidebar-archive-list' : 'session-archive-list'}
        >
            <View style={sidebar ? styles.sidebarContent : styles.pageContent}>{content}</View>
        </View>
    );
});
