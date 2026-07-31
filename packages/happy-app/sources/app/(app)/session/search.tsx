import * as React from 'react';
import {
    View,
    Text,
    TextInput,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Animated,
    PanResponder,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { EmptySessionsTablet, shouldShowSessionEmptyState } from '@/components/EmptySessionsTablet';
import { layout } from '@/components/layout';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import {
    useSessionManagementPreferences,
    type SessionManagementQueue,
} from '@/hooks/useSessionManagementPreferences';
import { useAllMachines, useAllSessions, useSessionListViewData, useUnreadSessionIds } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import {
    buildSessionManagementSections,
    getSessionManagementPrimaryStatus,
    type SessionManagementPrimaryStatus,
    type SessionManagementSortItem,
} from '@/utils/sessionManagementLayout';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { t } from '@/text';

type SessionFilter = 'all' | 'needs' | 'running' | 'pinned' | 'drafts';
type SessionSection = 'active' | 'pinned' | 'needs' | 'running' | 'recent';
type PrimaryStatus = SessionManagementPrimaryStatus;

interface ManagedSession extends SessionManagementSortItem {
    id: string;
    session: Session;
    title: string;
    subtitle: string;
    machineName: string | null;
    pinned: boolean;
    manualFocus: boolean;
    unread: boolean;
    hasPermission: boolean;
    running: boolean;
    hasDraft: boolean;
    incompleteTodosCount: number;
    totalTodosCount: number;
    needsAction: boolean;
    primaryStatus: PrimaryStatus;
    updatedAt: number;
}

const FILTERS: SessionFilter[] = ['all', 'needs', 'running', 'pinned', 'drafts'];
const DRAG_ROW_HEIGHT = 93;

export default React.memo(function SessionSearchScreen() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const [query, setQuery] = React.useState('');
    const [filter, setFilter] = React.useState<SessionFilter>('all');
    const [sortMode, setSortMode] = React.useState(false);
    const [expandedSessionId, setExpandedSessionId] = React.useState<string | null>(null);
    const sessions = useAllSessions();
    const sessionListViewData = useSessionListViewData();
    const machines = useAllMachines({ includeOffline: true });
    const unreadSessionIds = useUnreadSessionIds();
    const navigateToSession = useNavigateToSession();

    const validSessionIds = React.useMemo(() => sessions.map((session) => session.id), [sessions]);
    const management = useSessionManagementPreferences(validSessionIds);

    const activeSessionOrder = React.useMemo(() => {
        const activeItem = sessionListViewData?.find((item) => item.type === 'active-sessions');
        return activeItem?.type === 'active-sessions' ? activeItem.sessions.map((session) => session.id) : [];
    }, [sessionListViewData]);

    const machineNameById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const machine of machines) {
            map.set(machine.id, machine.metadata?.displayName || machine.metadata?.host || machine.id);
        }
        return map;
    }, [machines]);

    const managedSessions = React.useMemo(() => {
        return sessions.map((session): ManagedSession => {
            const hasPermission = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
            const incompleteTodosCount = session.todos?.filter((todo) => todo.status !== 'completed').length ?? 0;
            const totalTodosCount = session.todos?.length ?? 0;
            const manualFocus = management.isFocused(session.id);
            const unread = unreadSessionIds.has(session.id);
            const running = session.thinking === true;
            const hasDraft = !!session.draft;
            const needsAction = manualFocus || hasPermission || unread || hasDraft || incompleteTodosCount > 0;

            const primaryStatus = getSessionManagementPrimaryStatus({
                hasPermission,
                running,
                unread,
                hasDraft,
                incompleteTodosCount,
                manualFocus,
            });

            const machineId = session.metadata?.machineId ?? null;

            return {
                id: session.id,
                session,
                title: getSessionName(session),
                subtitle: getSessionSubtitle(session),
                machineName: machineId ? machineNameById.get(machineId) ?? null : null,
                pinned: management.isPinned(session.id),
                manualFocus,
                unread,
                hasPermission,
                running,
                hasDraft,
                incompleteTodosCount,
                totalTodosCount,
                needsAction,
                primaryStatus,
                updatedAt: session.updatedAt,
            };
        });
    }, [machineNameById, management, sessions, unreadSessionIds]);

    const filteredSessions = React.useMemo(() => {
        const trimmed = query.trim().toLowerCase();
        return managedSessions.filter((item) => {
            if (filter === 'needs' && !item.needsAction) return false;
            if (filter === 'running' && !item.running) return false;
            if (filter === 'pinned' && !item.pinned) return false;
            if (filter === 'drafts' && !item.hasDraft) return false;

            if (!trimmed) return true;
            return [item.title, item.subtitle, item.machineName ?? '', getPrimaryStatusLabel(item)]
                .join(' ')
                .toLowerCase()
                .includes(trimmed);
        });
    }, [filter, managedSessions, query]);

    const sections = React.useMemo(() => {
        const showActiveGroup = filter === 'all' && query.trim().length === 0;
        return buildSessionManagementSections({
            items: filteredSessions,
            activeSessionOrder,
            pinnedOrder: management.preferences.pinnedOrder,
            focusOrder: management.preferences.focusOrder,
            showActiveGroup,
        });
    }, [activeSessionOrder, filter, filteredSessions, management.preferences.focusOrder, management.preferences.pinnedOrder, query]);

    const allNeedsCount = managedSessions.filter((item) => item.needsAction).length;
    const hasQuery = query.trim().length > 0;
    const hasResults = filteredSessions.length > 0;
    const isSessionCollectionEmpty = shouldShowSessionEmptyState(managedSessions.length);

    const handleSessionPress = React.useCallback((sessionId: string) => {
        if (sortMode) {
            return;
        }
        navigateToSession(sessionId);
    }, [navigateToSession, sortMode]);

    if (isSessionCollectionEmpty) {
        return (
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.content}>
                    <EmptySessionsTablet title={t('sessionSearch.empty')} />
                </View>
            </KeyboardAvoidingView>
        );
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={styles.content}>
                <View style={styles.headerRow}>
                    <Pressable
                        onPress={() => setSortMode((current) => !current)}
                        style={({ pressed }) => [
                            styles.sortButton,
                            sortMode && styles.sortButtonActive,
                            pressed && styles.buttonPressed,
                        ]}
                    >
                        <Text style={[styles.sortButtonText, sortMode && styles.sortButtonTextActive]}>
                            {sortMode ? t('sessionSearch.sorting') : t('sessionSearch.sort')}
                        </Text>
                    </Pressable>
                </View>

                <View style={styles.searchBar}>
                    <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                    <TextInput
                        style={styles.searchInput}
                        placeholder={t('sessionSearch.placeholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={query}
                        onChangeText={setQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                    />
                    {hasQuery && (
                        <Pressable onPress={() => setQuery('')} hitSlop={10}>
                            <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>

                <ScrollView
                    horizontal
                    style={styles.filterScroller}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.filterRow}
                    keyboardShouldPersistTaps="handled"
                >
                    {FILTERS.map((item) => (
                        <FilterChip
                            key={item}
                            filter={item}
                            selected={filter === item}
                            onPress={() => setFilter(item)}
                        />
                    ))}
                </ScrollView>

                {sortMode && (
                    <View style={styles.sortHint}>
                        <Text style={styles.sortHintTitle}>{t('sessionSearch.sortHintTitle')}</Text>
                        <Text style={styles.sortHintBody}>{t('sessionSearch.sortHintBody')}</Text>
                    </View>
                )}

                <ScrollView
                    style={styles.list}
                    contentContainerStyle={[styles.listContent, { paddingBottom: safeArea.bottom + 92 }]}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                >
                    {hasResults ? (
                        <>
                            <SessionSectionView
                                section="pinned"
                                title={t('sessionSearch.sections.pinned')}
                                items={sections.pinned}
                                sortMode={sortMode}
                                expandedSessionId={expandedSessionId}
                                management={management}
                                onPressSession={handleSessionPress}
                                onToggleExpanded={setExpandedSessionId}
                            />
                            <SessionSectionView
                                section="active"
                                title={t('sessionSearch.sections.active')}
                                items={sections.active}
                                sortMode={sortMode}
                                expandedSessionId={expandedSessionId}
                                management={management}
                                onPressSession={handleSessionPress}
                                onToggleExpanded={setExpandedSessionId}
                            />
                            <SessionSectionView
                                section="needs"
                                title={t('sessionSearch.sections.needs')}
                                items={sections.needs}
                                sortMode={sortMode}
                                expandedSessionId={expandedSessionId}
                                management={management}
                                onPressSession={handleSessionPress}
                                onToggleExpanded={setExpandedSessionId}
                            />
                            <SessionSectionView
                                section="running"
                                title={t('sessionSearch.sections.running')}
                                items={sections.running}
                                sortMode={sortMode}
                                expandedSessionId={expandedSessionId}
                                management={management}
                                onPressSession={handleSessionPress}
                                onToggleExpanded={setExpandedSessionId}
                            />
                            <SessionSectionView
                                section="recent"
                                title={t('sessionSearch.sections.recent')}
                                items={sections.recent}
                                sortMode={sortMode}
                                expandedSessionId={expandedSessionId}
                                management={management}
                                onPressSession={handleSessionPress}
                                onToggleExpanded={setExpandedSessionId}
                            />
                        </>
                    ) : (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>
                                {hasQuery ? t('sessionSearch.noResults', { query: query.trim() }) : t('sessionSearch.empty')}
                            </Text>
                        </View>
                    )}
                </ScrollView>

                <View style={[styles.footerBar, { bottom: safeArea.bottom + 12 }]}>
                    <View style={styles.footerTextWrap}>
                        <Text style={styles.footerTitle}>
                            {sortMode ? t('sessionSearch.footerSortTitle') : t('sessionSearch.footerNeeds', { count: allNeedsCount })}
                        </Text>
                        <Text style={styles.footerSubtitle}>
                            {sortMode ? t('sessionSearch.footerSortSubtitle') : t('sessionSearch.footerNeedsSubtitle')}
                        </Text>
                    </View>
                    <Pressable
                        onPress={() => {
                            if (sortMode) {
                                setSortMode(false);
                                return;
                            }
                            setFilter('needs');
                        }}
                        style={({ pressed }) => [styles.footerButton, pressed && styles.footerButtonPressed]}
                    >
                        <Text style={styles.footerButtonText}>
                            {sortMode ? t('sessionSearch.done') : t('sessionSearch.view')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
});

const FilterChip = React.memo(({
    filter,
    selected,
    onPress,
}: {
    filter: SessionFilter;
    selected: boolean;
    onPress: () => void;
}) => (
    <Pressable
        onPress={onPress}
        style={({ pressed }) => [
            styles.filterChip,
            selected && styles.filterChipSelected,
            pressed && styles.buttonPressed,
        ]}
    >
        <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>
            {getFilterLabel(filter)}
        </Text>
    </Pressable>
));

const SessionSectionView = React.memo(({
    section,
    title,
    items,
    sortMode,
    expandedSessionId,
    management,
    onPressSession,
    onToggleExpanded,
}: {
    section: SessionSection;
    title: string;
    items: ManagedSession[];
    sortMode: boolean;
    expandedSessionId: string | null;
    management: ReturnType<typeof useSessionManagementPreferences>;
    onPressSession: (sessionId: string) => void;
    onToggleExpanded: (sessionId: string | null) => void;
}) => {
    if (items.length === 0) {
        return null;
    }

    return (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{title}</Text>
                <Text style={styles.sectionCount}>{items.length}</Text>
            </View>
            <View style={styles.cards}>
                {items.map((item) => (
                    <ManagedSessionRow
                        key={item.session.id}
                        item={item}
                        section={section}
                        sortMode={sortMode}
                        expanded={expandedSessionId === item.session.id}
                        management={management}
                        onPress={() => onPressSession(item.session.id)}
                        onToggleExpanded={() => onToggleExpanded(expandedSessionId === item.session.id ? null : item.session.id)}
                    />
                ))}
            </View>
        </View>
    );
});

const ManagedSessionRow = React.memo(({
    item,
    section,
    sortMode,
    expanded,
    management,
    onPress,
    onToggleExpanded,
}: {
    item: ManagedSession;
    section: SessionSection;
    sortMode: boolean;
    expanded: boolean;
    management: ReturnType<typeof useSessionManagementPreferences>;
    onPress: () => void;
    onToggleExpanded: () => void;
}) => {
    const queue: SessionManagementQueue | null = section === 'pinned'
        ? 'pinned'
        : section === 'needs'
            ? 'focus'
            : null;
    const statusColor = getStatusColor(item.primaryStatus);
    const subtitle = item.machineName
        ? (item.subtitle ? `${item.subtitle} · ${item.machineName}` : item.machineName)
        : item.subtitle;
    const canDrag = sortMode && queue != null;
    const dragTranslateY = React.useRef(new Animated.Value(0)).current;
    const [dragging, setDragging] = React.useState(false);

    const finishDrag = React.useCallback((offsetY: number) => {
        if (canDrag && queue) {
            const offset = Math.round(offsetY / DRAG_ROW_HEIGHT);
            if (offset !== 0) {
                management.moveWithinQueueByOffset(queue, item.session.id, offset);
            }
        }

        Animated.spring(dragTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            speed: 26,
            bounciness: 0,
        }).start();
        setDragging(false);
    }, [canDrag, dragTranslateY, item.session.id, management, queue]);

    const panResponder = React.useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => canDrag,
        onMoveShouldSetPanResponder: (_event, gesture) => (
            canDrag && Math.abs(gesture.dy) > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx)
        ),
        onPanResponderGrant: () => {
            setDragging(true);
            dragTranslateY.setValue(0);
        },
        onPanResponderMove: (_event, gesture) => {
            if (canDrag) {
                dragTranslateY.setValue(gesture.dy);
            }
        },
        onPanResponderRelease: (_event, gesture) => finishDrag(gesture.dy),
        onPanResponderTerminate: () => finishDrag(0),
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
    }), [canDrag, dragTranslateY, finishDrag]);

    return (
        <Animated.View
            style={[
                styles.cardShell,
                expanded && styles.cardShellExpanded,
                dragging && styles.cardShellDragging,
                canDrag && { transform: [{ translateY: dragTranslateY }], zIndex: dragging ? 3 : 0 },
            ]}
        >
            <Pressable
                onPress={sortMode ? undefined : onPress}
                onLongPress={sortMode ? undefined : onToggleExpanded}
                style={({ pressed }) => [styles.row, pressed && !sortMode && !dragging && styles.rowPressed]}
            >
                <View style={[styles.statusRail, { backgroundColor: statusColor }]} />
                <Avatar
                    id={getSessionAvatarId(item.session)}
                    size={42}
                    flavor={item.session.metadata?.flavor ?? null}
                    monochrome={!item.session.active}
                />
                <View style={styles.rowContent}>
                    <View style={styles.rowTitleLine}>
                        {item.unread && <View style={styles.unreadDot} />}
                        <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                        {item.pinned && (
                            <View style={styles.pinBadge}>
                                <Ionicons name="pin" size={10} color={styles.pinBadgeText.color} />
                            </View>
                        )}
                    </View>
                    {!!subtitle && (
                        <Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text>
                    )}
                    <View style={styles.badgeRow}>
                        {getBadges(item).map((badge) => (
                            <StatusBadge key={badge.key} label={badge.label} tone={badge.tone} />
                        ))}
                    </View>
                </View>
                <View style={styles.rowActions}>
                    {sortMode ? (
                        queue ? (
                            <View style={styles.sortControls}>
                                <View
                                    {...(canDrag ? panResponder.panHandlers : {})}
                                    style={[styles.dragHandle, dragging && styles.dragHandleActive]}
                                >
                                    <Ionicons name="reorder-three" size={16} color={styles.iconButtonIcon.color} />
                                </View>
                                <IconButton
                                    icon="arrow-up"
                                    accessibilityLabel={t('sessionSearch.actions.moveUp')}
                                    onPress={() => management.moveWithinQueue(queue, item.session.id, 'up')}
                                />
                                <IconButton
                                    icon="arrow-down"
                                    accessibilityLabel={t('sessionSearch.actions.moveDown')}
                                    onPress={() => management.moveWithinQueue(queue, item.session.id, 'down')}
                                />
                            </View>
                        ) : (
                            <View style={styles.queueControls}>
                                <Pressable
                                    onPress={() => management.moveToPinned(item.session.id)}
                                    style={({ pressed }) => [styles.queueButton, pressed && styles.buttonPressed]}
                                >
                                    <Text style={styles.queueButtonText}>{t('sessionSearch.actions.moveToPinned')}</Text>
                                </Pressable>
                                <Pressable
                                    onPress={() => management.moveToFocus(item.session.id)}
                                    style={({ pressed }) => [styles.queueButton, pressed && styles.buttonPressed]}
                                >
                                    <Text style={styles.queueButtonText}>{t('sessionSearch.actions.moveToNeeds')}</Text>
                                </Pressable>
                            </View>
                        )
                    ) : (
                        <Pressable
                            onPress={onToggleExpanded}
                            hitSlop={8}
                            style={({ pressed }) => [styles.moreButton, pressed && styles.buttonPressed]}
                            accessibilityLabel={t('sessionSearch.actions.more')}
                        >
                            <Ionicons name="ellipsis-vertical" size={17} color={styles.moreButtonIcon.color} />
                        </Pressable>
                    )}
                </View>
            </Pressable>

            {expanded && !sortMode && (
                <View style={styles.inlineActions}>
                    <ActionPill
                        icon={item.pinned ? 'pin' : 'pin-outline'}
                        label={item.pinned ? t('sessionSearch.actions.unpin') : t('sessionSearch.actions.pin')}
                        onPress={() => management.togglePinned(item.session.id)}
                    />
                    <ActionPill
                        icon={item.manualFocus ? 'alert-circle' : 'alert-circle-outline'}
                        label={item.manualFocus ? t('sessionSearch.actions.clearNeeds') : t('sessionSearch.actions.markNeeds')}
                        onPress={() => management.toggleFocus(item.session.id)}
                    />
                    <ActionPill
                        icon="arrow-up"
                        label={t('sessionSearch.actions.moveToTop')}
                        onPress={() => {
                            if (item.pinned) {
                                management.moveToQueueTop('pinned', item.session.id);
                            } else {
                                management.moveToQueueTop('focus', item.session.id);
                            }
                        }}
                    />
                </View>
            )}
        </Animated.View>
    );
});

const IconButton = React.memo(({
    icon,
    accessibilityLabel,
    onPress,
}: {
    icon: keyof typeof Ionicons.glyphMap;
    accessibilityLabel: string;
    onPress: () => void;
}) => (
    <Pressable
        onPress={onPress}
        hitSlop={6}
        style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}
        accessibilityLabel={accessibilityLabel}
    >
        <Ionicons name={icon} size={15} color={styles.iconButtonIcon.color} />
    </Pressable>
));

const ActionPill = React.memo(({
    icon,
    label,
    onPress,
}: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
}) => (
    <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.actionPill, pressed && styles.buttonPressed]}
    >
        <Ionicons name={icon} size={14} color={styles.actionPillText.color} />
        <Text style={styles.actionPillText}>{label}</Text>
    </Pressable>
));

const StatusBadge = React.memo(({ label, tone }: { label: string; tone: PrimaryStatus | 'pin' }) => (
    <View style={[styles.statusBadge, getBadgeStyle(tone)]}>
        <Text style={[styles.statusBadgeText, getBadgeTextStyle(tone)]}>{label}</Text>
    </View>
));

function getFilterLabel(filter: SessionFilter): string {
    switch (filter) {
        case 'all': return t('sessionSearch.filters.all');
        case 'needs': return t('sessionSearch.filters.needs');
        case 'running': return t('sessionSearch.filters.running');
        case 'pinned': return t('sessionSearch.filters.pinned');
        case 'drafts': return t('sessionSearch.filters.drafts');
    }
}

function getPrimaryStatusLabel(item: ManagedSession): string {
    switch (item.primaryStatus) {
        case 'permission': return t('sessionSearch.status.permission');
        case 'running': return t('sessionSearch.status.running');
        case 'unread': return t('sessionSearch.status.unread');
        case 'draft': return t('sessionSearch.status.draft');
        case 'todo': return t('sessionSearch.status.todo');
        case 'manual': return t('sessionSearch.status.manual');
        case 'recent': return t('sessionSearch.status.recent');
    }
}

function getBadges(item: ManagedSession): { key: string; label: string; tone: PrimaryStatus | 'pin' }[] {
    const badges: { key: string; label: string; tone: PrimaryStatus | 'pin' }[] = [
        { key: item.primaryStatus, label: getPrimaryStatusLabel(item), tone: item.primaryStatus },
    ];

    if (item.hasDraft && item.primaryStatus !== 'draft') {
        badges.push({ key: 'draft', label: t('sessionSearch.status.draft'), tone: 'draft' });
    }

    if (item.incompleteTodosCount > 0) {
        badges.push({
            key: 'todo',
            label: `${t('sessionSearch.status.todo')} ${item.incompleteTodosCount}/${item.totalTodosCount}`,
            tone: 'todo',
        });
    }

    return badges;
}

function getStatusColor(status: PrimaryStatus): string {
    switch (status) {
        case 'permission': return '#E65C5C';
        case 'running': return '#4D9BEA';
        case 'unread': return '#32B96E';
        case 'draft': return '#7554C8';
        case 'todo': return '#8C9A86';
        case 'manual': return '#F2A33A';
        case 'recent': return '#99A195';
    }
}

function getBadgeStyle(tone: PrimaryStatus | 'pin') {
    switch (tone) {
        case 'permission': return styles.badgePermission;
        case 'running': return styles.badgeRunning;
        case 'unread': return styles.badgeUnread;
        case 'draft': return styles.badgeDraft;
        case 'todo': return styles.badgeTodo;
        case 'manual': return styles.badgeManual;
        case 'recent': return styles.badgeRecent;
        case 'pin': return styles.badgeUnread;
    }
}

function getBadgeTextStyle(tone: PrimaryStatus | 'pin') {
    switch (tone) {
        case 'permission': return styles.badgePermissionText;
        case 'running': return styles.badgeRunningText;
        case 'unread': return styles.badgeUnreadText;
        case 'draft': return styles.badgeDraftText;
        case 'todo': return styles.badgeTodoText;
        case 'manual': return styles.badgeManualText;
        case 'recent': return styles.badgeRecentText;
        case 'pin': return styles.badgeUnreadText;
    }
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        flex: 1,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        marginHorizontal: 18,
        marginTop: 12,
        marginBottom: 12,
    },
    sortButton: {
        minHeight: 38,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    sortButtonActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sortButtonText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    sortButtonTextActive: {
        color: theme.colors.text,
    },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 18,
        marginBottom: 10,
        paddingHorizontal: 16,
        paddingVertical: Platform.OS === 'ios' ? 14 : 8,
        borderRadius: 18,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default(),
    },
    filterScroller: {
        flexGrow: 0,
        flexShrink: 0,
        height: 46,
        marginBottom: 12,
    },
    filterRow: {
        gap: 8,
        alignItems: 'center',
        paddingHorizontal: 18,
    },
    filterChip: {
        height: 34,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    filterChipSelected: {
        backgroundColor: theme.colors.text,
        borderColor: theme.colors.text,
    },
    filterChipText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    filterChipTextSelected: {
        color: theme.colors.surface,
    },
    sortHint: {
        marginHorizontal: 18,
        marginBottom: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 18,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    sortHintTitle: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    sortHintBody: {
        marginTop: 3,
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    list: {
        flex: 1,
    },
    listContent: {
        paddingHorizontal: 18,
        paddingBottom: 32,
    },
    section: {
        marginTop: 12,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 2,
        paddingBottom: 7,
    },
    sectionTitle: {
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },
    sectionCount: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    cards: {
        borderRadius: 22,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity * 0.55,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 8 },
        elevation: 3,
    },
    cardShell: {
        backgroundColor: theme.colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    cardShellExpanded: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    cardShellDragging: {
        opacity: 0.86,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        elevation: 7,
    },
    row: {
        minHeight: 92,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingRight: 14,
        paddingVertical: 13,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    statusRail: {
        width: 8,
        height: 8,
        marginLeft: 14,
        borderRadius: 4,
    },
    rowContent: {
        flex: 1,
        minWidth: 0,
        gap: 5,
    },
    rowTitleLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    unreadDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: theme.colors.accent,
    },
    rowTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    pinBadge: {
        width: 18,
        height: 18,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#E8F7EE',
    },
    pinBadgeText: {
        color: '#195435',
    },
    rowSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        flexWrap: 'wrap',
    },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 9,
    },
    statusBadgeText: {
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    badgePermission: {
        backgroundColor: '#FFECEC',
    },
    badgePermissionText: {
        color: '#8B2424',
    },
    badgeRunning: {
        backgroundColor: '#EAF4FF',
    },
    badgeRunningText: {
        color: '#164A7B',
    },
    badgeUnread: {
        backgroundColor: '#E8F7EE',
    },
    badgeUnreadText: {
        color: '#195435',
    },
    badgeDraft: {
        backgroundColor: '#F0ECFF',
    },
    badgeDraftText: {
        color: '#513B8C',
    },
    badgeTodo: {
        backgroundColor: theme.colors.surfacePressed,
    },
    badgeTodoText: {
        color: theme.colors.textSecondary,
    },
    badgeManual: {
        backgroundColor: '#FFF2DF',
    },
    badgeManualText: {
        color: '#76500F',
    },
    badgeRecent: {
        backgroundColor: theme.colors.surfacePressed,
    },
    badgeRecentText: {
        color: theme.colors.textSecondary,
    },
    rowActions: {
        minWidth: 34,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    moreButton: {
        width: 34,
        height: 34,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
    },
    moreButtonIcon: {
        color: theme.colors.textSecondary,
    },
    sortControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    dragHandle: {
        width: 30,
        height: 30,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfacePressed,
    },
    dragHandleActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    iconButton: {
        width: 32,
        height: 32,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfacePressed,
    },
    iconButtonIcon: {
        color: theme.colors.textSecondary,
    },
    queueControls: {
        gap: 5,
        alignItems: 'flex-end',
    },
    queueButton: {
        minHeight: 31,
        minWidth: 48,
        paddingHorizontal: 10,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#E8F7EE',
    },
    queueButtonText: {
        fontSize: 11,
        color: '#195435',
        ...Typography.default('semiBold'),
    },
    inlineActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 16,
        paddingBottom: 14,
        paddingLeft: 24,
    },
    actionPill: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        borderRadius: 15,
        backgroundColor: theme.colors.surfacePressed,
    },
    actionPillText: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    footerBar: {
        position: 'absolute',
        left: 18,
        right: 18,
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 22,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity * 0.8,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
        elevation: 8,
    },
    footerTextWrap: {
        flex: 1,
        minWidth: 0,
    },
    footerTitle: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    footerSubtitle: {
        marginTop: 2,
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    footerButton: {
        minWidth: 70,
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.text,
    },
    footerButtonPressed: {
        opacity: 0.85,
    },
    footerButtonText: {
        fontSize: 13,
        color: theme.colors.surface,
        ...Typography.default('semiBold'),
    },
    buttonPressed: {
        opacity: 0.78,
    },
    emptyContainer: {
        minHeight: 240,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 15,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
