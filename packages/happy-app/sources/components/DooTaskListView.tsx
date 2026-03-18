import * as React from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, TextInput, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BottomSheetModal, BottomSheetFlatList, BottomSheetTextInput, BottomSheetBackdrop } from '@gorhom/bottom-sheet';

const SheetTextInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskTasks, useDootaskFilters, useDootaskProfile, useDootaskProjects, useDootaskUserCache } from '@/sync/storage';
import { dootaskFetchProjects } from '@/sync/dootask/api';
import { parseFlowItem, FLOW_STATUS_COLORS } from '@/sync/dootask/types';
import type { DooTaskItem, DooTaskProject } from '@/sync/dootask/types';
import { useShallow } from 'zustand/react/shallow';

/**
 * Format end_at date as countdown or short date (matches DooTask dashboard logic).
 * - Within 7 days: countdown like "3d 05h", "-1d 02h" (negative = overdue)
 * - Beyond 7 days: "MM-DD" (same year) or "YYYY-MM-DD"
 */
function formatEndAt(endAt: string): string {
    const now = Date.now();
    const end = new Date(endAt).getTime();
    if (isNaN(end)) return endAt;

    const diffSec = Math.floor((end - now) / 1000);
    if (Math.abs(diffSec) < 86400 * 7) {
        const pre = diffSec < 0 ? '-' : '';
        const abs = Math.abs(diffSec);
        const days = Math.floor(abs / 86400);
        const hours = Math.floor((abs % 86400) / 3600);
        const minutes = Math.floor((abs % 3600) / 60);
        if (days > 0) return `${pre}${days}d ${String(hours).padStart(2, '0')}h`;
        if (hours > 0) return `${pre}${hours}h ${String(minutes).padStart(2, '0')}min`;
        return `${pre}${minutes}min`;
    }

    const d = new Date(end);
    const nowDate = new Date(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === nowDate.getFullYear()) return `${mm}-${dd}`;
    return `${d.getFullYear()}-${mm}-${dd}`;
}

// --- Flavor icons for AI providers ---
const flavorIconSources: Record<string, any> = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

/** Build a map of taskId → unique flavor strings from all sessions linked to dootask tasks. */
function useTaskFlavorsMap(serverUrl: string | undefined): Record<string, string[]> {
    const sessions = storage(useShallow((s) => s.sessions));
    return React.useMemo(() => {
        if (!serverUrl) return {};
        const normalizedUrl = serverUrl.replace(/\/+$/, '').toLowerCase();
        const map: Record<string, Set<string>> = {};
        for (const s of Object.values(sessions)) {
            const ctx = s.metadata?.externalContext;
            if (!ctx || ctx.source !== 'dootask' || ctx.resourceType !== 'task') continue;
            if (ctx.sourceUrl && ctx.sourceUrl.replace(/\/+$/, '').toLowerCase() !== normalizedUrl) continue;
            const flavor = s.metadata?.flavor;
            if (!flavor || !flavorIconSources[flavor]) continue;
            (map[ctx.resourceId] ??= new Set()).add(flavor);
        }
        const result: Record<string, string[]> = {};
        for (const [id, set] of Object.entries(map)) result[id] = [...set];
        return result;
    }, [sessions, serverUrl]);
}

const FLAVOR_ICON_SIZE = 16;
const FLAVOR_OVERLAP_RATIO = 0.3;

const FlavorBadges = React.memo(({ flavors }: { flavors: string[] }) => {
    const { theme } = useUnistyles();
    if (flavors.length === 0) return null;
    const outerSize = FLAVOR_ICON_SIZE;
    const step = outerSize * (1 - FLAVOR_OVERLAP_RATIO);
    const totalWidth = outerSize + step * (flavors.length - 1);
    return (
        <View style={{ width: totalWidth, height: outerSize }}>
            {flavors.map((flavor, i) => {
                // codex slightly smaller than others (matching Avatar.tsx convention)
                const iconSize = flavor === 'codex' ? 10 : 12;
                return (
                    <View
                        key={flavor}
                        style={{
                            position: 'absolute',
                            left: i * step,
                            width: outerSize,
                            height: outerSize,
                            borderRadius: outerSize / 2,
                            backgroundColor: theme.colors.surface,
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: i,
                            shadowColor: theme.colors.shadow.color,
                            shadowOffset: { width: 0, height: 1 },
                            shadowOpacity: 0.2,
                            shadowRadius: 2,
                            elevation: 3,
                        }}
                    >
                        <Image
                            source={flavorIconSources[flavor]}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={flavor === 'codex' ? theme.colors.text : undefined}
                        />
                    </View>
                );
            })}
        </View>
    );
});

// --- Filter Panel Modal ---
const PICKER_ITEM_HEIGHT = 48;

type FilterPanelModalProps = {
    onRefreshTasks: () => void;
};

const FilterPanelModal = React.memo(React.forwardRef<BottomSheetModal, FilterPanelModalProps>(({ onRefreshTasks }, ref) => {
    const { theme } = useUnistyles();
    const filters = useDootaskFilters();
    const projects = useDootaskProjects();
    const profile = useDootaskProfile();

    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchedProjects, setSearchedProjects] = React.useState<DooTaskProject[] | null>(null);
    const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchQueryRef = React.useRef(searchQuery);
    searchQueryRef.current = searchQuery;

    const showSearch = projects.length > 20;

    const roleOptions: Array<{ key: 'all' | 'owner' | 'assist'; label: string }> = [
        { key: 'all', label: t('dootask.roleAll') },
        { key: 'owner', label: t('dootask.roleOwner') },
        { key: 'assist', label: t('dootask.roleAssist') },
    ];

    const currentRole = filters.role || 'all';

    const handleSearchChange = React.useCallback((text: string) => {
        setSearchQuery(text);
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        if (!text) {
            setSearchedProjects(null);
            return;
        }
        const query = text;
        searchTimerRef.current = setTimeout(async () => {
            if (!profile) return;
            try {
                const res = await dootaskFetchProjects(profile.serverUrl, profile.token, { keys: { name: query } });
                if (res.ret === 1 && query === searchQueryRef.current) {
                    setSearchedProjects((res.data?.data || res.data || []).map((p: any) => ({ id: p.id, name: p.name })));
                }
            } catch { /* silent */ }
        }, 600);
    }, [profile]);

    const projectSource = searchedProjects ?? projects;

    const filteredProjects = React.useMemo(() => {
        if (!searchQuery) return projectSource;
        const q = searchQuery.toLowerCase();
        return projectSource.filter((p) => p.name.toLowerCase().includes(q));
    }, [projectSource, searchQuery]);

    const selectProject = React.useCallback((id: number | undefined) => {
        storage.getState().setDootaskFilter({ projectId: id });
        onRefreshTasks();
    }, [onRefreshTasks]);

    const selectRole = React.useCallback((role: 'all' | 'owner' | 'assist') => {
        storage.getState().setDootaskFilter({ role });
        onRefreshTasks();
    }, [onRefreshTasks]);

    const data = React.useMemo(() => [null, ...filteredProjects] as (DooTaskProject | null)[], [filteredProjects]);

    const renderProjectItem = React.useCallback(({ item }: { item: DooTaskProject | null }) => {
        const isAll = item === null;
        const isSelected = isAll ? !filters.projectId : filters.projectId === item!.id;
        return (
            <Pressable
                style={({ pressed }) => [
                    styles.pickerItem,
                    pressed && !isSelected && { backgroundColor: theme.colors.surfacePressed },
                ]}
                onPress={() => !isSelected && selectProject(isAll ? undefined : item!.id)}
            >
                <Text
                    style={[styles.pickerItemText, { color: theme.colors.text }]}
                    numberOfLines={1}
                >
                    {isAll ? t('dootask.allProjects') : item!.name}
                </Text>
                {isSelected ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : null}
            </Pressable>
        );
    }, [filters.projectId, selectProject, theme]);

    const handleDismiss = React.useCallback(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        setSearchQuery('');
        setSearchedProjects(null);
    }, []);

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    const ListHeaderComponent = React.useMemo(() => (
        <>
            {/* Role Section */}
            <View style={styles.filterSectionHeader}>
                <Text style={[styles.filterSectionTitle, { color: theme.colors.textSecondary }]}>
                    {t('dootask.role')}
                </Text>
            </View>
            <View style={styles.roleChipRow}>
                {roleOptions.map((opt) => (
                    <Pressable
                        key={opt.key}
                        style={[
                            styles.chip,
                            { backgroundColor: currentRole === opt.key ? theme.colors.button.primary.background : theme.colors.groupped.background },
                        ]}
                        onPress={() => selectRole(opt.key)}
                    >
                        <Text style={[
                            styles.chipText,
                            { color: currentRole === opt.key ? theme.colors.button.primary.tint : theme.colors.text },
                        ]}>
                            {opt.label}
                        </Text>
                    </Pressable>
                ))}
            </View>

            {/* Project Section */}
            <View style={styles.filterSectionHeader}>
                <Text style={[styles.filterSectionTitle, { color: theme.colors.textSecondary }]}>
                    {t('dootask.project')}
                </Text>
            </View>
            {showSearch ? (
                <View style={styles.pickerSearch}>
                    <SheetTextInput
                        style={[styles.pickerSearchInput, {
                            color: theme.colors.text,
                            backgroundColor: theme.colors.groupped.background,
                        }, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
                        placeholder={t('dootask.searchProjects')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={searchQuery}
                        onChangeText={handleSearchChange}
                        autoCorrect={false}
                    />
                </View>
            ) : null}
        </>
    ), [theme, currentRole, searchQuery, showSearch, handleSearchChange, selectRole]);

    return (
        <BottomSheetModal
            ref={ref}
            snapPoints={['60%']}
            enableDynamicSizing={false}
            backdropComponent={renderBackdrop}
            onDismiss={handleDismiss}
            keyboardBehavior="interactive"
            keyboardBlurBehavior="restore"
            android_keyboardInputMode="adjustResize"
            backgroundStyle={{ backgroundColor: theme.colors.surface }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            <View style={[styles.pickerTitle, { borderBottomColor: theme.colors.divider }]}>
                <Text style={[styles.pickerTitleText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.filter')}
                </Text>
            </View>
            <BottomSheetFlatList
                data={data}
                keyExtractor={(item: DooTaskProject | null) => item === null ? '__all__' : String(item.id)}
                renderItem={renderProjectItem}
                ListHeaderComponent={ListHeaderComponent}
                keyboardShouldPersistTaps="handled"
            />
        </BottomSheetModal>
    );
}));

// --- Filter Bar ---
type FilterBarProps = {
    onRefreshTasks: () => void;
};

const FilterBar = React.memo(({ onRefreshTasks }: FilterBarProps) => {
    const filters = useDootaskFilters();
    const projects = useDootaskProjects();
    const { theme } = useUnistyles();
    const [searchText, setSearchText] = React.useState(filters.search || '');
    const pickerRef = React.useRef<BottomSheetModal>(null);

    const statusOptions: Array<{ key: 'all' | 'uncompleted' | 'completed'; label: string }> = [
        { key: 'all', label: t('dootask.allStatuses') },
        { key: 'uncompleted', label: t('dootask.uncompleted') },
        { key: 'completed', label: t('dootask.completed') },
    ];

    const filterChipLabel = React.useMemo(() => {
        const parts: string[] = [];
        const role = filters.role || 'all';
        if (role === 'owner') parts.push(t('dootask.roleOwner'));
        if (role === 'assist') parts.push(t('dootask.roleAssist'));
        if (filters.projectId) {
            const p = projects.find((p) => p.id === filters.projectId);
            if (p) parts.push(p.name);
        }
        return parts.length > 0 ? parts.join(' · ') : t('dootask.filter');
    }, [filters.projectId, filters.role, projects]);

    const hasActiveFilters = !!filters.projectId || (!!filters.role && filters.role !== 'all');

    const applySearch = React.useCallback((rawText: string) => {
        const normalized = rawText.trim();
        const nextSearch = normalized ? normalized : undefined;
        const currentSearch = storage.getState().dootaskFilters.search;
        if (currentSearch === nextSearch) return;
        storage.getState().setDootaskFilter({ search: nextSearch });
        onRefreshTasks();
    }, [onRefreshTasks]);

    const handleSearchChange = (text: string) => {
        setSearchText(text);
    };

    const handleClearSearch = () => {
        setSearchText('');
        applySearch('');
    };

    return (
        <View style={styles.filterBar}>
            <View style={[styles.searchBox, { backgroundColor: theme.colors.surface }]}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput
                    style={[styles.searchInput, { color: theme.colors.text }, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
                    placeholder={t('dootask.searchPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={searchText}
                    onChangeText={handleSearchChange}
                    onSubmitEditing={() => applySearch(searchText)}
                    onEndEditing={() => applySearch(searchText)}
                    returnKeyType="search"
                    autoCorrect={false}
                    underlineColorAndroid="transparent"
                />
                {searchText ? (
                    <Pressable onPress={handleClearSearch} hitSlop={8}>
                        <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                ) : null}
            </View>
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
                            onRefreshTasks();
                        }}
                    >
                        <Text style={[
                            styles.chipText,
                            { color: filters.status === opt.key ? theme.colors.button.primary.tint : theme.colors.text },
                        ]}>
                            {opt.label}
                        </Text>
                    </Pressable>
                ))}
                <Pressable
                    style={[
                        styles.chip,
                        { backgroundColor: hasActiveFilters ? theme.colors.button.primary.background : theme.colors.surface },
                    ]}
                    onPress={() => pickerRef.current?.present()}
                >
                    <Text
                        style={[
                            styles.chipText,
                            { color: hasActiveFilters ? theme.colors.button.primary.tint : theme.colors.text },
                        ]}
                        numberOfLines={1}
                    >
                        {filterChipLabel}
                    </Text>
                    <Ionicons
                        name="chevron-down"
                        size={12}
                        color={hasActiveFilters ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
            <FilterPanelModal ref={pickerRef} onRefreshTasks={onRefreshTasks} />
        </View>
    );
});

// --- Task Card ---
const TaskCard = React.memo(({ item, projectName, columnName, userCache, flavors, onPress }: { item: DooTaskItem; projectName: string; columnName?: string; userCache: Record<number, string>; flavors?: string[]; onPress: () => void }) => {
    const { theme } = useUnistyles();
    const isCompleted = !!item.complete_at;
    const flow = item.flow_item_name ? parseFlowItem(item.flow_item_name) : null;
    const flowColor = flow?.color || theme.colors.textSecondary;

    const owners = (item.task_user || []).filter((u) => u.owner === 1).reverse();
    const getName = (u: { userid: number; nickname: string }) => userCache[u.userid] || u.nickname || String(u.userid);
    const assigneeText = owners.length <= 2
        ? owners.map(getName).join(', ')
        : `${getName(owners[0])} +${owners.length - 1}`;

    const hasTime = !!item.end_at && !isCompleted;
    const hasAssignees = owners.length > 0;

    return (
        <Pressable style={[styles.card, { backgroundColor: theme.colors.surface }]} onPress={onPress}>
            <View style={styles.cardHeader}>
                <View style={[styles.priorityBar, { backgroundColor: item.p_color || theme.colors.textSecondary }]} />
                <Text style={[styles.cardTitle, { color: theme.colors.text }]} numberOfLines={2}>
                    {item.name}
                </Text>
            </View>
            <View style={styles.cardMeta}>
                {flow ? (
                    <View style={[styles.statusBadge, { backgroundColor: flowColor + '20' }]}>
                        <Text style={[styles.statusBadgeText, { color: flowColor }]}>
                            {flow.name}
                        </Text>
                    </View>
                ) : (
                    <View style={[styles.statusBadge, { backgroundColor: (isCompleted ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start) + '20' }]}>
                        <Text style={[styles.statusBadgeText, { color: isCompleted ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start }]}>
                            {isCompleted ? t('dootask.completed') : t('dootask.uncompleted')}
                        </Text>
                    </View>
                )}
                {projectName ? (
                    <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {projectName}{columnName ? ` · ${columnName}` : ''}
                    </Text>
                ) : null}
                {item.sub_num && item.sub_num > 0 ? (
                    <View style={styles.subCountBadge}>
                        <Ionicons name="git-branch-outline" size={12} color={theme.colors.textSecondary} />
                        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                            {item.sub_complete || 0}/{item.sub_num}
                        </Text>
                    </View>
                ) : null}
                {item.msg_num && item.msg_num > 0 ? (
                    <View style={styles.subCountBadge}>
                        <Ionicons name="chatbubble-outline" size={11} color={theme.colors.textSecondary} />
                        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                            {item.msg_num}
                        </Text>
                    </View>
                ) : null}
            </View>
            <View style={styles.cardBottom}>
                {hasTime ? (
                    <Text style={[
                        styles.metaText,
                        { color: item.overdue ? theme.colors.deleteAction : theme.colors.textSecondary },
                    ]}>
                        {formatEndAt(item.end_at!)}
                        {item.overdue ? ` (${t('dootask.overdue')})` : ''}
                    </Text>
                ) : <View />}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {hasAssignees ? (
                        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                            {assigneeText}
                        </Text>
                    ) : null}
                    {flavors && flavors.length > 0 ? <FlavorBadges flavors={flavors} /> : null}
                </View>
            </View>
        </Pressable>
    );
});

// --- Main List ---
export const DooTaskListView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { tasks, loading, error, pager } = useDootaskTasks();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const taskFlavorsMap = useTaskFlavorsMap(profile?.serverUrl);
    const [isPullRefreshing, setIsPullRefreshing] = React.useState(false);
    const isRefreshRunningRef = React.useRef(false);
    const hasQueuedRefreshRef = React.useRef(false);

    const handlePullRefresh = React.useCallback(async () => {
        if (isRefreshRunningRef.current) {
            hasQueuedRefreshRef.current = true;
            return;
        }

        isRefreshRunningRef.current = true;
        const startedAt = Date.now();
        setIsPullRefreshing(true);
        try {
            do {
                hasQueuedRefreshRef.current = false;
                await storage.getState().fetchDootaskTasks({ refresh: true });
            } while (hasQueuedRefreshRef.current);
        } finally {
            const elapsed = Date.now() - startedAt;
            if (elapsed < 300) {
                await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
            }
            isRefreshRunningRef.current = false;
            setIsPullRefreshing(false);
        }
    }, []);

    const triggerRefreshWithFeedback = React.useCallback(() => {
        void handlePullRefresh();
    }, [handlePullRefresh]);

    React.useEffect(() => {
        if (profile) {
            storage.getState().fetchDootaskProjects();
            storage.getState().fetchDootaskTasks({ refresh: true });
        }
    }, [profile?.serverUrl, profile?.token]);

    // Fetch missing user nicknames for all task assignees
    React.useEffect(() => {
        if (!tasks.length) return;
        const ids = new Set<number>();
        for (const task of tasks) {
            for (const u of task.task_user || []) {
                if (u.userid && !userCache[u.userid]) ids.add(u.userid);
            }
        }
        if (ids.size > 0) storage.getState().fetchDootaskUsers([...ids]);
    }, [tasks, userCache]);

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
                    <Text style={[styles.retryText, { color: theme.colors.button.primary.tint }]}>{t('dootask.reconnect')}</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <View style={{ flex: 1, maxWidth: 800, alignSelf: 'center', width: '100%' }}>
                <FilterBar onRefreshTasks={triggerRefreshWithFeedback} />
                <FlatList
                    data={tasks}
                    keyExtractor={(item) => String(item.id)}
                    renderItem={({ item }) => (
                        <TaskCard
                            item={item}
                            projectName={item.project_name || ''}
                            columnName={item.column_name}
                            userCache={userCache}
                            flavors={taskFlavorsMap[String(item.id)]}
                            onPress={() => router.push(`/dootask/${item.id}`)}
                        />
                    )}
                    refreshControl={
                        <RefreshControl
                            refreshing={isPullRefreshing}
                            onRefresh={handlePullRefresh}
                        />
                    }
                    onEndReached={() => {
                        if (pager.hasMore && !loading) {
                            storage.getState().fetchDootaskTasks({ loadMore: true });
                        }
                    }}
                    onEndReachedThreshold={0.5}
                    ListEmptyComponent={
                        loading && !isPullRefreshing ? (
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
                        loading && !isPullRefreshing && tasks.length > 0 ? <ActivityIndicator style={{ padding: 16 }} /> : null
                    }
                    contentContainerStyle={styles.list}
                />
                {error && error !== 'token_expired' ? (
                    <View style={[styles.errorBanner, { backgroundColor: theme.colors.deleteAction + '20' }]}>
                        <Text style={[styles.errorText, { color: theme.colors.deleteAction }]}>{error}</Text>
                        <Pressable onPress={triggerRefreshWithFeedback}>
                            <Text style={styles.retryText}>{t('common.retry')}</Text>
                        </Pressable>
                    </View>
                ) : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((_theme) => ({
    filterBar: { paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
    searchBox: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        paddingHorizontal: 10,
        height: 36,
        gap: 6,
    },
    searchInput: {
        flex: 1,
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 18,
        height: 36,
        textAlignVertical: 'center',
        includeFontPadding: false,
        paddingHorizontal: 0,
        paddingVertical: 0,
        margin: 0,
    },
    filterRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, gap: 4 },
    chipText: { ...Typography.default(), fontSize: 13 },
    list: { paddingHorizontal: 16, paddingBottom: 20 },
    card: {
        padding: 14,
        borderRadius: 10,
        marginTop: 8,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    priorityBar: { width: 3, alignSelf: 'stretch' as const, borderRadius: 1.5 },
    cardTitle: { ...Typography.default('semiBold'), fontSize: 15, flex: 1 },
    cardMeta: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' },
    statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    statusBadgeText: { ...Typography.default(), fontSize: 11 },
    metaText: { ...Typography.default(), fontSize: 12, lineHeight: 18 },
    subCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    cardBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, minHeight: 20 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
    emptyTitle: { ...Typography.default('semiBold'), fontSize: 16 },
    emptyText: { ...Typography.default(), fontSize: 14, textAlign: 'center', marginTop: 4 },
    retryButton: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
    retryText: { ...Typography.default('semiBold'), fontSize: 14 },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
    },
    errorText: { fontSize: 13, ...Typography.default() },
    // --- Filter Panel ---
    filterSectionHeader: {
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 4,
    },
    filterSectionTitle: { fontSize: 13, ...Typography.default('semiBold') },
    roleChipRow: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 20,
        paddingVertical: 10,
    },
    pickerTitle: {
        paddingVertical: 8,
        paddingHorizontal: 20,
        alignItems: 'center',
    },
    pickerTitleText: { fontSize: 13, ...Typography.default('semiBold') },
    pickerSearch: {
        paddingHorizontal: 20,
        paddingVertical: 8,
    },
    pickerSearchInput: {
        borderRadius: 8,
        paddingHorizontal: 10,
        height: 32,
        fontSize: 14,
        ...Typography.default(),
        padding: 0,
    },
    pickerItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: PICKER_ITEM_HEIGHT,
        paddingHorizontal: 20,
    },
    pickerItemText: { fontSize: 15, ...Typography.default(), flex: 1 },
}));
