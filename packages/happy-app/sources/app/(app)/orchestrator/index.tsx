import * as React from 'react';
import { View, FlatList, Pressable, ActivityIndicator, ScrollView, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useAuth } from '@/auth/AuthContext';
import { listOrchestratorRuns, type ListOrchestratorRunsQuery, type OrchestratorRunDetail } from '@/sync/apiOrchestrator';
import { OrchestratorStatusBadge } from '@/components/orchestrator/OrchestratorStatusBadge';
import { formatDate } from '@/utils/formatDate';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type RunListItem = Pick<OrchestratorRunDetail, 'runId' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'summary'>;
type StatusFilter = 'all' | 'active' | 'terminal' | 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled';

const FILTERS: Array<{ key: StatusFilter; label: string; }> = [
    { key: 'all', label: t('settings.orchestratorFilterAll') },
    { key: 'active', label: t('settings.orchestratorFilterActive') },
    { key: 'terminal', label: t('settings.orchestratorFilterTerminal') },
    { key: 'running', label: t('settings.orchestratorFilterRunning') },
    { key: 'failed', label: t('settings.orchestratorFilterFailed') },
    { key: 'completed', label: t('settings.orchestratorFilterCompleted') },
    { key: 'cancelled', label: t('settings.orchestratorFilterCancelled') },
];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    filterBar: {
        flexGrow: 0,
        flexShrink: 0,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
        paddingTop: 12,
        paddingBottom: 8,
    },
    filterInner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
    },
    filterChip: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    filterChipActive: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    filterChipText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    filterChipTextActive: {
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
    },
    listContent: {
        paddingHorizontal: 16,
        paddingBottom: 24,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 14,
        marginBottom: 10,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    title: {
        flex: 1,
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
    },
    meta: {
        marginTop: 8,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    progressRow: {
        marginTop: 10,
    },
    progressTrack: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHighest,
        overflow: 'hidden',
    },
    progressFill: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.button.primary.background,
    },
    summary: {
        marginTop: 8,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    loadingMore: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    emptySubtitle: {
        marginTop: 8,
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    errorText: {
        marginTop: 8,
        fontSize: 14,
        color: theme.colors.textDestructive,
        textAlign: 'center',
    },
}));

function getFilterStatus(statusFilter: StatusFilter): ListOrchestratorRunsQuery['status'] | undefined {
    if (statusFilter === 'all') {
        return undefined;
    }
    return statusFilter;
}

export default function OrchestratorRunsScreen() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const searchParams = useLocalSearchParams<{ controllerSessionId?: string | string[]; }>();
    const auth = useAuth();
    const credentials = auth.credentials;
    const controllerSessionId = React.useMemo(() => (
        Array.isArray(searchParams.controllerSessionId)
            ? searchParams.controllerSessionId[0]
            : searchParams.controllerSessionId
    ), [searchParams.controllerSessionId]);
    const isConversationScoped = !!controllerSessionId;
    const navigation = useNavigation();

    React.useEffect(() => {
        if (isConversationScoped) {
            navigation.setOptions({
                headerTitle: () => (
                    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={[Typography.default('semiBold'), { fontSize: 17, lineHeight: 24, color: theme.colors.header.tint }]}>
                            {t('settings.orchestratorRuns')}
                        </Text>
                        <Text style={[Typography.default(), { fontSize: 12, color: theme.colors.header.tint, opacity: 0.7, marginTop: -2 }]}>
                            {t('settings.orchestratorSessionRuns')}
                        </Text>
                    </View>
                ),
            });
        } else {
            navigation.setOptions({
                headerTitle: t('settings.orchestratorRuns'),
            });
        }
    }, [isConversationScoped, navigation, theme]);

    const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('active');
    const [runs, setRuns] = React.useState<RunListItem[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const fetchRuns = React.useCallback(async (opts?: { cursor?: string; append?: boolean; silent?: boolean; }) => {
        if (!credentials) {
            return;
        }
        const append = opts?.append === true;
        if (append) {
            setLoadingMore(true);
        } else if (!opts?.silent) {
            setLoading(true);
        }

        try {
            setError(null);
            const result = await listOrchestratorRuns(credentials, {
                status: getFilterStatus(statusFilter),
                limit: 50,
                cursor: opts?.cursor,
                controllerSessionId,
            });
            setRuns((previous) => append ? [...previous, ...result.items] : result.items);
            setNextCursor(result.nextCursor);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load orchestrator runs');
        } finally {
            if (append) {
                setLoadingMore(false);
            } else {
                setLoading(false);
            }
            setRefreshing(false);
        }
    }, [credentials, controllerSessionId, statusFilter]);

    const handleRefresh = React.useCallback(() => {
        setRefreshing(true);
        void fetchRuns({ silent: true });
    }, [fetchRuns]);

    const handleLoadMore = React.useCallback(() => {
        if (!nextCursor || loadingMore || loading) {
            return;
        }
        void fetchRuns({ cursor: nextCursor, append: true, silent: true });
    }, [fetchRuns, nextCursor, loadingMore, loading]);

    useFocusEffect(React.useCallback(() => {
        let active = true;
        void fetchRuns();

        const interval = setInterval(() => {
            if (!active) {
                return;
            }
            void fetchRuns({ silent: true });
        }, 5000);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [fetchRuns]));

    const renderRunItem = React.useCallback(({ item }: { item: RunListItem; }) => {
        const done = item.summary.completed + item.summary.failed + item.summary.cancelled;
        const progress = item.summary.total > 0 ? Math.max(0, Math.min(1, done / item.summary.total)) : 0;

        return (
            <Pressable
                style={styles.card}
                onPress={() => router.push(`/orchestrator/${item.runId}`)}
            >
                <View style={styles.cardHeader}>
                    <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                    <OrchestratorStatusBadge status={item.status} />
                </View>
                <Text style={styles.meta}>
                    Updated {formatDate(item.updatedAt)}
                </Text>
                <View style={styles.progressRow}>
                    <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                    </View>
                    <Text style={styles.summary}>
                        Total {item.summary.total} · Running {item.summary.running} · Completed {item.summary.completed} · Failed {item.summary.failed} · Cancelled {item.summary.cancelled}
                    </Text>
                </View>
            </Pressable>
        );
    }, [router, styles]);

    const listEmpty = React.useMemo(() => {
        if (loading) {
            return (
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" />
                    <Text style={styles.emptySubtitle}>{t('settings.orchestratorLoading')}</Text>
                </View>
            );
        }
        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyTitle}>{t('settings.orchestratorNoRuns')}</Text>
                <Text style={styles.emptySubtitle}>
                    {isConversationScoped
                        ? t('settings.orchestratorSessionRunsEmpty')
                        : t('settings.orchestratorNoRunsMatch')}
                </Text>
                {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>
        );
    }, [loading, styles, error, isConversationScoped]);

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.filterBar}
                contentContainerStyle={styles.filterInner}
            >
                {FILTERS.map((filter) => (
                    <Pressable
                        key={filter.key}
                        style={[styles.filterChip, statusFilter === filter.key && styles.filterChipActive]}
                        onPress={() => setStatusFilter(filter.key)}
                    >
                        <Text style={[styles.filterChipText, statusFilter === filter.key && styles.filterChipTextActive]}>
                            {filter.label}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>

            <FlatList
                data={runs}
                keyExtractor={(item) => item.runId}
                renderItem={renderRunItem}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.4}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={theme.colors.textSecondary}
                    />
                }
                contentContainerStyle={[
                    styles.listContent,
                    runs.length === 0 && { flex: 1 },
                    { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
                ]}
                ListFooterComponent={loadingMore ? (
                    <View style={styles.loadingMore}>
                        <ActivityIndicator />
                    </View>
                ) : null}
                ListEmptyComponent={listEmpty}
            />
        </View>
    );
}
