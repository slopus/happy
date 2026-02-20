import * as React from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskTasks, useDootaskFilters, useDootaskProfile } from '@/sync/storage';
import type { DooTaskItem } from '@/sync/dootask/types';

// --- Filter Bar ---
const FilterBar = React.memo(() => {
    const filters = useDootaskFilters();
    const { theme } = useUnistyles();

    const statusOptions: Array<{ key: 'all' | 'uncompleted' | 'completed'; label: string }> = [
        { key: 'all', label: t('dootask.allStatuses') },
        { key: 'uncompleted', label: t('dootask.uncompleted') },
        { key: 'completed', label: t('dootask.completed') },
    ];

    return (
        <View style={styles.filterBar}>
            <View style={styles.filterRow}>
                {statusOptions.map((opt) => (
                    <Pressable
                        key={opt.key}
                        style={[
                            styles.chip,
                            { backgroundColor: filters.status === opt.key ? theme.colors.button.primary.background : theme.colors.surface },
                        ]}
                        onPress={() => {
                            storage.getState().setDootaskFilter({ status: opt.key });
                            storage.getState().fetchDootaskTasks({ refresh: true });
                        }}
                    >
                        <Text style={[
                            styles.chipText,
                            { color: filters.status === opt.key ? '#fff' : theme.colors.text },
                        ]}>
                            {opt.label}
                        </Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
});

// --- Task Card ---
const TaskCard = React.memo(({ item, onPress }: { item: DooTaskItem; onPress: () => void }) => {
    const { theme } = useUnistyles();
    const owner = item.taskUser?.find((u) => u.owner === 1);

    return (
        <Pressable style={[styles.card, { backgroundColor: theme.colors.surface }]} onPress={onPress}>
            <View style={styles.cardHeader}>
                <View style={[styles.priorityDot, { backgroundColor: item.p_color || theme.colors.textSecondary }]} />
                <Text style={[styles.cardTitle, { color: theme.colors.text }]} numberOfLines={2}>
                    {item.name}
                </Text>
            </View>
            <View style={styles.cardMeta}>
                <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                    {item.project_name}
                </Text>
                {item.flow_item_name ? (
                    <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                        {item.flow_item_name}
                    </Text>
                ) : null}
                {owner ? (
                    <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                        {owner.nickname}
                    </Text>
                ) : null}
            </View>
            {item.end_at ? (
                <Text style={[
                    styles.metaText,
                    { color: item.overdue ? theme.colors.deleteAction : theme.colors.textSecondary, marginTop: 4 },
                ]}>
                    {item.end_at}
                    {item.overdue ? ` (${t('dootask.overdue')})` : ''}
                </Text>
            ) : null}
        </Pressable>
    );
});

// --- Main List ---
export const DooTaskListView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { tasks, loading, error, pager } = useDootaskTasks();
    const profile = useDootaskProfile();

    React.useEffect(() => {
        if (profile) {
            storage.getState().fetchDootaskProjects();
            storage.getState().fetchDootaskTasks({ refresh: true });
        }
    }, [profile?.serverUrl, profile?.token]);

    if (!profile) {
        return (
            <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.connectFirst')}
                </Text>
            </View>
        );
    }

    if (error === 'token_expired') {
        return (
            <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: theme.colors.deleteAction }]}>
                    {t('dootask.tokenExpired')}
                </Text>
                <Pressable
                    style={[styles.retryButton, { backgroundColor: theme.colors.button.primary.background }]}
                    onPress={() => router.push('/settings/connect/dootask')}
                >
                    <Text style={styles.retryText}>{t('dootask.reconnect')}</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <FilterBar />
            <FlatList
                data={tasks}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item }) => (
                    <TaskCard
                        item={item}
                        onPress={() => router.push(`/dootask/${item.id}`)}
                    />
                )}
                refreshControl={
                    <RefreshControl
                        refreshing={loading && tasks.length > 0}
                        onRefresh={() => storage.getState().fetchDootaskTasks({ refresh: true })}
                    />
                }
                onEndReached={() => {
                    if (pager.hasMore && !loading) {
                        storage.getState().fetchDootaskTasks({ loadMore: true });
                    }
                }}
                onEndReachedThreshold={0.5}
                ListEmptyComponent={
                    loading ? (
                        <ActivityIndicator style={{ marginTop: 40 }} />
                    ) : (
                        <View style={styles.empty}>
                            <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                                {t('dootask.noTasks')}
                            </Text>
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t('dootask.noTasksDescription')}
                            </Text>
                        </View>
                    )
                }
                ListFooterComponent={
                    loading && tasks.length > 0 ? <ActivityIndicator style={{ padding: 16 }} /> : null
                }
                contentContainerStyle={styles.list}
            />
            {error && error !== 'token_expired' ? (
                <View style={[styles.errorBanner, { backgroundColor: theme.colors.deleteAction + '20' }]}>
                    <Text style={[styles.errorText, { color: theme.colors.deleteAction }]}>{error}</Text>
                    <Pressable onPress={() => storage.getState().fetchDootaskTasks({ refresh: true })}>
                        <Text style={styles.retryText}>{t('common.retry')}</Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    filterBar: { paddingHorizontal: 16, paddingVertical: 8 },
    filterRow: { flexDirection: 'row', gap: 8 },
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
    chipText: { ...Typography.default(), fontSize: 13 },
    list: { paddingHorizontal: 16, paddingBottom: 20 },
    card: {
        padding: 14,
        borderRadius: 10,
        marginTop: 8,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
    cardTitle: { ...Typography.default('semiBold'), fontSize: 15, flex: 1 },
    cardMeta: { flexDirection: 'row', gap: 12, marginTop: 6, flexWrap: 'wrap' },
    metaText: { ...Typography.default(), fontSize: 12 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
    emptyTitle: { ...Typography.default('semiBold'), fontSize: 16 },
    emptyText: { ...Typography.default(), fontSize: 14, textAlign: 'center', marginTop: 4 },
    retryButton: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
    retryText: { color: '#fff', ...Typography.default('semiBold'), fontSize: 14 },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
    },
    errorText: { fontSize: 13, ...Typography.default() },
}));
