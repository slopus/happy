import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Avatar } from '@/components/Avatar';
import { EmptySessionsTablet, shouldShowSessionEmptyState } from '@/components/EmptySessionsTablet';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useAllSessions, useIsDataReady } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';

type SessionHistoryListVariant = 'page' | 'sidebar';

type SessionHistoryItem =
    | { key: string; type: 'date-header'; date: string }
    | { key: string; type: 'session'; session: Session };

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.groupped.background },
    pageContainer: { alignItems: 'stretch', flexDirection: 'row', justifyContent: 'center' },
    pageContent: { flex: 1, maxWidth: 960 },
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

function groupSessionsByDate(sessions: Session[]): SessionHistoryItem[] {
    const items: SessionHistoryItem[] = [];
    let previousDateKey: string | null = null;
    for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const date = new Date(session.updatedAt);
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
    const safeArea = useSafeAreaInsets();
    const allSessions = useAllSessions();
    const isDataReady = useIsDataReady();
    const navigateToSession = useNavigateToSession();
    const pathname = usePathname();
    const sidebar = variant === 'sidebar';
    const scrollRequested = React.useRef(false);
    React.useEffect(() => {
        if (!isDataReady || (sidebar && pathname !== '/new' && pathname !== '/')) return;
        const timer = setTimeout(() => { void sync.sessionRouteBecameInteractive(); }, 0);
        return () => clearTimeout(timer);
    }, [isDataReady, pathname, sidebar]);
    const groupedItems = React.useMemo(() => groupSessionsByDate(allSessions ?? []), [allSessions]);
    const loadNextHistoryPage = React.useCallback(() => {
        if (!scrollRequested.current) return;
        scrollRequested.current = false;
        void sync.loadNextSessionHistoryPage();
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionHistoryItem; index: number }) => {
        if (item.type === 'date-header') {
            return (
                <View style={[styles.dateHeader, sidebar && styles.dateHeaderSidebar]}>
                    <Text style={[styles.dateHeaderText, sidebar && styles.dateHeaderTextSidebar]}>{item.date}</Text>
                </View>
            );
        }

        const { session } = item;
        const selected = pathname === `/session/${session.id}`;
        const previousItem = index > 0 ? groupedItems[index - 1] : null;
        const nextItem = index < groupedItems.length - 1 ? groupedItems[index + 1] : null;
        const first = previousItem?.type === 'date-header';
        const last = nextItem?.type === 'date-header' || nextItem == null;

        return (
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => navigateToSession(session.id)}
                style={({ pressed }) => [
                    styles.sessionCard,
                    sidebar && styles.sessionCardSidebar,
                    !sidebar && first && last
                        ? styles.sessionCardSingle
                        : !sidebar && first
                            ? styles.sessionCardFirst
                            : !sidebar && last
                                ? styles.sessionCardLast
                                : null,
                    selected && styles.sessionCardSelected,
                    pressed && styles.sessionCardPressed,
                ]}
                testID={`session-history-row-${session.id}`}
            >
                <Avatar id={getSessionAvatarId(session)} size={sidebar ? 30 : 48} />
                <View style={[styles.sessionContent, sidebar && styles.sessionContentSidebar]}>
                    <Text numberOfLines={1} style={[styles.sessionTitle, sidebar && styles.sessionTitleSidebar]}>
                        {getSessionName(session)}
                    </Text>
                    <Text numberOfLines={1} style={[styles.sessionSubtitle, sidebar && styles.sessionSubtitleSidebar]}>
                        {getSessionSubtitle(session)}
                    </Text>
                </View>
            </Pressable>
        );
    }, [groupedItems, navigateToSession, pathname, sidebar, styles]);

    const content = shouldShowSessionEmptyState(groupedItems.length)
        ? <EmptySessionsTablet title={t('sessionHistory.empty')} />
        : (
            <FlatList
                contentContainerStyle={[
                    sidebar ? styles.listContentSidebar : styles.listContentPage,
                    { paddingBottom: safeArea.bottom + 16 },
                ]}
                data={groupedItems}
                keyExtractor={(item) => item.key}
                onScrollBeginDrag={() => { scrollRequested.current = true; }}
                onEndReached={loadNextHistoryPage}
                onEndReachedThreshold={0.5}
                renderItem={renderItem}
            />
        );

    return (
        <View
            style={[styles.container, !sidebar && styles.pageContainer]}
            testID={sidebar ? 'desktop-sidebar-history-list' : 'session-history-list'}
        >
            <View style={!sidebar ? styles.pageContent : undefined}>{content}</View>
        </View>
    );
});
