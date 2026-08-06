import React from 'react';
import { View, Pressable, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { filterProjectGroup, sessionMatchesQuery } from '@/sync/projectGroups';
import { Ionicons } from '@expo/vector-icons';
import { type SessionState, formatLastSeen, vibingMessages } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { ProjectGroup } from './ProjectGroup';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { useBatchArchive } from '@/hooks/useBatchArchive';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { ProviderIcon } from './ProviderIcon';

const stylesheet = StyleSheet.create((theme) => ({
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
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: theme.colors.surfaceHigh }),
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
        backgroundColor: 'transparent',
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
    },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    sessionItemSingle: {
        borderRadius: 12,
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: 12,
        marginBottom: 12,
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
    sessionShortcutBadge: {
        flexShrink: 0,
        marginLeft: 8,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
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
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    archiveToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 16,
    },
    archiveToggleLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.groupped.sectionTitle,
        opacity: 0.3,
    },
    archiveToggleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 12,
        ...Typography.default('semiBold'),
    },
    batchFab: {
        position: 'absolute',
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 4,
    },
    batchFabText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    batchBar: {
        position: 'absolute',
        left: 16,
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 6,
    },
    batchBarCount: {
        flex: 1,
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    batchBarProgress: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
        ...Typography.default(),
    },
    batchBarTextButton: {
        paddingHorizontal: 8,
        paddingVertical: 8,
    },
    batchBarTextButtonText: {
        fontSize: 13,
        fontWeight: '500',
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
    batchBarArchiveButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        backgroundColor: '#FF3B30',
    },
    batchBarArchiveButtonDisabled: {
        opacity: 0.4,
    },
    batchBarArchiveButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#FFFFFF',
        ...Typography.default('semiBold'),
    },
    batchCheckContainer: {
        width: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function SessionsList({
    topContentInset = 0,
    bottomContentInset = 128,
    onScroll,
    searchQuery = '',
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    searchQuery?: string;
} = {}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const sourceData = useVisibleSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const toggleArchived = React.useCallback(() => {
        setHideInactiveSessions(!hideInactiveSessions);
    }, [hideInactiveSessions, setHideInactiveSessions]);

    // ---- Batch selection mode ----
    // Self-contained selection mode: floating entry button, checkboxes on
    // session rows, and a bottom action bar for bulk operations. Sessions
    // nested inside project groups are not selectable in v1.
    const [batchMode, setBatchMode] = React.useState(false);
    const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
    const [batchArchiveState, runBatchArchive] = useBatchArchive(React.useCallback((ok: number, failed: number) => {
        setSelectedIds(new Set());
        setBatchMode(false);
        Modal.alert(
            t('batch.archive'),
            t('batch.archiveResult', { ok, failed }),
            [{ text: t('common.ok'), style: 'cancel' }],
        );
    }, []));

    const enterBatchMode = React.useCallback(() => {
        setSelectedIds(new Set());
        setBatchMode(true);
    }, []);

    const exitBatchMode = React.useCallback(() => {
        setBatchMode(false);
        setSelectedIds(new Set());
    }, []);

    const toggleSelect = React.useCallback((sessionId: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId);
            else next.add(sessionId);
            return next;
        });
    }, []);

    // (visibleSessionIds / select-all / archive-confirm are defined after the
    // `data` memo below, since they derive the selectable set from it.)
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    // Request review
    React.useEffect(() => {
        if (sourceData && sourceData.length > 0) {
            requestReview();
        }
    }, [sourceData && sourceData.length > 0]);

    const data = React.useMemo(() => {
        const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
        if (!sourceData || !normalizedQuery) {
            return sourceData;
        }

        const matches = (session: SessionRowData) => sessionMatchesQuery(session, normalizedQuery);

        // Projects nest their sessions inside worktrees, so they need a pass of
        // their own: the index walk below only ever sees flat `session` items.
        const keptProjects = new Map<number, SessionListViewItem>();
        sourceData.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = filterProjectGroup(item.project, normalizedQuery);
            if (project) keptProjects.set(index, { ...item, project });
        });

        const keepIndices = new Set<number>();
        let currentHeaderIndex: number | null = null;
        let currentProjectIndex: number | null = null;

        sourceData.forEach((item, index) => {
            if (item.type === 'header') {
                currentHeaderIndex = index;
                currentProjectIndex = null;
                return;
            }
            if (item.type === 'project-group') {
                currentProjectIndex = index;
                return;
            }
            if (item.type === 'session' && matches(item.session)) {
                keepIndices.add(index);
                if (currentHeaderIndex !== null) keepIndices.add(currentHeaderIndex);
                if (currentProjectIndex !== null) keepIndices.add(currentProjectIndex);
            }
        });

        const result: SessionListViewItem[] = [];
        sourceData.forEach((item, index) => {
            if (item.type === 'active-sessions') {
                const sessions = item.sessions.filter(matches);
                if (sessions.length > 0) result.push({ ...item, sessions });
                return;
            }
            if (item.type === 'projects-header') {
                if (keptProjects.size > 0) result.push(item);
                return;
            }
            if (item.type === 'project') {
                const kept = keptProjects.get(index);
                if (kept) result.push(kept);
                return;
            }
            if (keepIndices.has(index)) result.push(item);
        });
        return result;
    }, [searchQuery, sourceData]);

    // Everything the user can currently see: flat sessions plus the compact
    // active-sessions group. Project-group sessions are out of scope for v1.
    const visibleSessionIds = React.useMemo(() => {
        const ids: string[] = [];
        if (!data) return ids;
        for (const item of data) {
            if (item.type === 'session') ids.push(item.session.id);
            else if (item.type === 'active-sessions') {
                for (const session of item.sessions) ids.push(session.id);
            }
        }
        return ids;
    }, [data]);

    const allSelected = visibleSessionIds.length > 0 && visibleSessionIds.every(id => selectedIds.has(id));

    const toggleSelectAll = React.useCallback(() => {
        setSelectedIds(prev => {
            const everythingSelected = visibleSessionIds.length > 0
                && visibleSessionIds.every(id => prev.has(id));
            return everythingSelected ? new Set() : new Set(visibleSessionIds);
        });
    }, [visibleSessionIds]);

    const confirmBatchArchive = React.useCallback(() => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0 || batchArchiveState.running) return;
        Modal.alert(
            t('batch.archive'),
            t('batch.archiveConfirm', { count: ids.length }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('batch.archive'),
                    style: 'destructive',
                    onPress: () => { void runBatchArchive(ids); },
                },
            ],
        );
    }, [batchArchiveState.running, runBatchArchive, selectedIds]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'archive-toggle': return 'archive-toggle';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'projects-header': return 'projects-header';
            case 'project': return `project-${item.project.id}`;
            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem, index: number }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'archive-toggle':
                return (
                    <Pressable style={styles.archiveToggle} onPress={toggleArchived}>
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );

            case 'active-sessions':
                // In batch mode the compact group yields to flat selectable
                // rows so active sessions can be picked for bulk operations.
                if (batchMode) {
                    return (
                        <View>
                            {item.sessions.map((session, i) => (
                                <SessionItem
                                    key={`batch-active-${session.id}`}
                                    session={session}
                                    isFirst={i === 0}
                                    isLast={i === item.sessions.length - 1}
                                    isSingle={item.sessions.length === 1}
                                    batchMode
                                    checked={selectedIds.has(session.id)}
                                    onToggleSelect={toggleSelect}
                                />
                            ))}
                        </View>
                    );
                }
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                    />
                );

            case 'projects-header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {t('sidebar.projects')}
                        </Text>
                    </View>
                );

            case 'project':
                return (
                    <ProjectGroup
                        project={item.project}
                        selectedSessionId={selectedSessionId}
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
                // Determine card styling based on position within date group
                const prevItem = index > 0 ? data[index - 1] : null;
                const nextItem = index < data.length - 1 ? data[index + 1] : null;

                const isFirst = prevItem?.type === 'header';
                const isLast = nextItem?.type === 'header' || nextItem == null || nextItem?.type === 'active-sessions';
                const isSingle = isFirst && isLast;
                const selected = item.session.id === selectedSessionId;

                return (
                    <SessionItem
                        session={item.session}
                        selected={selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                        batchMode={batchMode}
                        checked={batchMode && selectedIds.has(item.session.id)}
                        onToggleSelect={toggleSelect}
                    />
                );
        }
    }, [selectedSessionId, data, toggleArchived, batchMode, selectedIds, toggleSelect]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <UpdateBanner />
        );
    }, []);

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={{ selectedSessionId, batchMode, selectedIds }}
                    contentContainerStyle={{
                        paddingTop: topContentInset,
                        paddingBottom: safeArea.bottom + bottomContentInset,
                        maxWidth: layout.maxWidth,
                    }}
                    ListHeaderComponent={HeaderComponent}
                    ListEmptyComponent={searchQuery.trim() ? (
                        <View style={{ paddingTop: 48, alignItems: 'center' }}>
                            <Text style={styles.headerText}>{t('sessionHistory.empty')}</Text>
                        </View>
                    ) : null}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                />
            </View>
            {batchMode ? (
                <View style={[styles.batchBar, { bottom: safeArea.bottom + 12 }]}>
                    <Pressable onPress={exitBatchMode} style={styles.batchBarTextButton} hitSlop={8}>
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.batchBarCount}>
                            {t('batch.selectedCount', { count: selectedIds.size })}
                        </Text>
                        {batchArchiveState.running && (
                            <Text style={styles.batchBarProgress}>
                                {t('batch.archivingProgress', { done: batchArchiveState.done, total: batchArchiveState.total })}
                            </Text>
                        )}
                    </View>
                    <Pressable onPress={toggleSelectAll} style={styles.batchBarTextButton} disabled={batchArchiveState.running}>
                        <Text style={styles.batchBarTextButtonText}>
                            {allSelected ? t('batch.clear') : t('batch.selectAll')}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={confirmBatchArchive}
                        disabled={selectedIds.size === 0 || batchArchiveState.running}
                        style={[
                            styles.batchBarArchiveButton,
                            (selectedIds.size === 0 || batchArchiveState.running) && styles.batchBarArchiveButtonDisabled,
                        ]}
                    >
                        <Ionicons name="archive-outline" size={15} color="#FFFFFF" />
                        <Text style={styles.batchBarArchiveButtonText}>
                            {t('batch.archive')}
                        </Text>
                    </Pressable>
                </View>
            ) : (
                <Pressable
                    onPress={enterBatchMode}
                    style={[styles.batchFab, { bottom: safeArea.bottom + bottomContentInset + 8 }]}
                    hitSlop={8}
                >
                    <Ionicons name="checkmark-circle-outline" size={17} color={theme.colors.text} />
                    <Text style={styles.batchFabText}>{t('batch.select')}</Text>
                </Pressable>
            )}
        </View>
    );
}

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle, batchMode, checked, onToggleSelect }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    batchMode?: boolean;
    checked?: boolean;
    onToggleSelect?: (sessionId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const baseStatus = STATUS_CONFIG[session.state];
    // Override to solid blue when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, color: '#007AFF', dotColor: '#007AFF', isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [session.state]);

    const statusText = session.hasUnread
        ? t('status.unread')
        : session.state === 'thinking'
            ? vibingMessage
            : session.state === 'disconnected'
                ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
                : session.state === 'permission_required'
                    ? t('status.permissionRequired')
                    : t('status.online');

    const handlePress = React.useCallback(() => {
        if (batchMode) {
            onToggleSelect?.(session.id);
            return;
        }
        navigateToSession(session.id);
    }, [batchMode, navigateToSession, onToggleSelect, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    // Batch mode replaces the per-session menu with selection toggling.
    const menuProps = batchMode ? {} : Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    return (
        <View style={[
            styles.sessionItemContainer,
            isSingle ? styles.sessionItemContainerSingle :
                isFirst ? styles.sessionItemContainerFirst :
                    isLast ? styles.sessionItemContainerLast : {}
        ]}>
        <Pressable
            style={[
                styles.sessionItem,
                (selected || checked) && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            {batchMode && (
                <View style={styles.batchCheckContainer}>
                    <Ionicons
                        name={checked ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={checked ? theme.colors.textLink : theme.colors.textSecondary}
                    />
                </View>
            )}
            <View style={styles.avatarContainer}>
                <Avatar id={session.avatarId} size={48} monochrome={!status.isConnected} flavor={session.flavor} clientId={session.clientId} />
                {session.hasDraft && (
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
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}>
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge
                        sessionId={session.id}
                        style={styles.sessionShortcutBadge}
                    />
                </View>

                {session.identityLine ? (
                    <View style={styles.sessionSubtitleRow}>
                        <ProviderIcon kind={session.providerKind} size={13} />
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.identityLine}
                        </Text>
                    </View>
                ) : session.path ? (
                    <View style={styles.sessionSubtitleRow}>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.path.split(/[/\\]/).filter(Boolean).pop()}
                        </Text>
                    </View>
                ) : (
                    <Text style={styles.sessionSubtitle} numberOfLines={1}>
                        {session.subtitle}
                    </Text>
                )}

                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                    </View>
                    <Text style={[
                        styles.statusText,
                        { color: status.color }
                    ]}>
                        {session.modelName ? `${session.modelName} · ` : ''}{statusText}{session.activitySummary ? ` · ${session.activitySummary}` : ''}
                    </Text>
                </View>
            </View>
        </Pressable>
        {Platform.OS === 'web' && (
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        )}
        </View>
    );
});
