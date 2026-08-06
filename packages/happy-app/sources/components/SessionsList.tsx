import React from 'react';
import { ActivityIndicator, View, Pressable, FlatList, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { Feather } from '@expo/vector-icons';
import { type SessionState, getSessionStateLabel } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
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
import { SessionActionsAnchor } from './SessionActionsPopover';
import {
    SessionRowActions,
    SessionRowDetails,
    SessionRowLocation,
    useSessionRowDisclosure,
    useSessionRowPresentation,
} from './SessionRowChrome';
import { storage, useSettingMutable } from '@/sync/storage';
import { hapticsLight } from './haptics';
import { t } from '@/text';
import { Modal } from '@/modal';
import { bulkArchiveSessions, bulkDeleteSessions } from '@/hooks/bulkSessionActions';
import { useSessionSelection } from '@/hooks/useSessionSelection';

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
    sessionPressTarget: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'visible',
        position: 'relative',
        zIndex: 0,
    },
    sessionItemContainerRaised: {
        zIndex: 40,
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
        alignItems: 'center',
        justifyContent: 'center',
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
        backgroundColor: theme.colors.groupped.background,
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
    bulkToolbar: {
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 0,
        minHeight: 56,
        borderRadius: 16,
        backgroundColor: theme.colors.header.background,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    bulkToolbarTitle: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    bulkToolbarButton: {
        minWidth: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surfaceSelected,
    },
    bulkToolbarTextButton: {
        minWidth: 72,
    },
    bulkToolbarButtonText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    bulkToolbarDangerText: {
        color: theme.colors.status.error,
    },
    selectionCheckbox: {
        width: 20,
        height: 20,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectionCheckboxSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
}));

export function SessionsList() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const selectionMode = useSessionSelection((s) => s.active);
    const selectedIds = useSessionSelection((s) => s.selectedIds);
    const startSelection = useSessionSelection((s) => s.enterSelection);
    const toggleSelection = useSessionSelection((s) => s.toggleSelection);
    const clearSelection = useSessionSelection((s) => s.clearSelection);
    const [bulkProcessing, setBulkProcessing] = React.useState<'archive' | 'delete' | null>(null);
    const toggleArchived = React.useCallback(() => {
        setHideInactiveSessions(!hideInactiveSessions);
    }, [hideInactiveSessions, setHideInactiveSessions]);
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    const selectedCount = selectedIds.size;

    const getSelectedSessions = React.useCallback(() => {
        const sessions = storage.getState().sessions;
        return Array.from(selectedIds)
            .map(id => sessions[id])
            .filter(Boolean);
    }, [selectedIds]);

    const archiveSelected = React.useCallback(async () => {
        const sessions = getSelectedSessions();
        if (sessions.length === 0) return;

        const confirmed = await Modal.confirm(
            t('sessionInfo.bulkArchiveSessions'),
            t('sessionInfo.bulkArchiveConfirm', { count: sessions.length }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('sessionInfo.bulkArchiveSessions'),
                destructive: true,
            },
        );
        if (!confirmed) return;

        setBulkProcessing('archive');
        try {
            await bulkArchiveSessions(sessions);
            clearSelection();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('sessionInfo.failedToArchiveSession'));
        } finally {
            setBulkProcessing(null);
        }
    }, [clearSelection, getSelectedSessions]);

    const deleteSelected = React.useCallback(async () => {
        const sessions = getSelectedSessions();
        if (sessions.length === 0) return;

        const confirmed = await Modal.confirm(
            t('sessionInfo.bulkDeleteSessions'),
            t('sessionInfo.bulkDeleteConfirm', { count: sessions.length }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('sessionInfo.bulkDeleteSessions'),
                destructive: true,
            },
        );
        if (!confirmed) return;

        setBulkProcessing('delete');
        try {
            await bulkDeleteSessions(sessions);
            clearSelection();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('sessionInfo.failedToDeleteSession'));
        } finally {
            setBulkProcessing(null);
        }
    }, [clearSelection, getSelectedSessions]);

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

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'archive-toggle': return 'archive-toggle';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
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
                    <Pressable
                        accessibilityRole="button"
                        style={styles.archiveToggle}
                        onPress={toggleArchived}
                        testID="session-archive-toggle"
                    >
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );

            case 'active-sessions':
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                        selectionMode={selectionMode}
                        selectedIds={selectedIds}
                        onStartSelection={startSelection}
                        onToggleSelection={toggleSelection}
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
                        bulkSelected={selectedIds.has(item.session.id)}
                        selectionMode={selectionMode}
                        onStartSelection={startSelection}
                        onToggleSelection={toggleSelection}
                    />
                );
        }
    }, [selectedSessionId, data, toggleArchived, selectionMode, selectedIds, startSelection, toggleSelection]);


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
                    extraData={`${selectedSessionId ?? ''}:${selectionMode}:${Array.from(selectedIds).join(',')}`}
                    contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                    ListHeaderComponent={HeaderComponent}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                />
                {selectionMode && (
                    <View style={[styles.bulkToolbar, { bottom: safeArea.bottom + 16 }]}>
                        <Text style={styles.bulkToolbarTitle}>
                            {t('sessionInfo.selectedSessions', { count: selectedCount })}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            disabled={bulkProcessing !== null || selectedCount === 0}
                            onPress={archiveSelected}
                            style={[styles.bulkToolbarButton, styles.bulkToolbarTextButton]}
                        >
                            {bulkProcessing === 'archive' ? (
                                <ActivityIndicator size="small" />
                            ) : (
                                <Text style={styles.bulkToolbarButtonText}>{t('sessionInfo.bulkArchiveSessions')}</Text>
                            )}
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            disabled={bulkProcessing !== null || selectedCount === 0}
                            onPress={deleteSelected}
                            style={[styles.bulkToolbarButton, styles.bulkToolbarTextButton]}
                        >
                            {bulkProcessing === 'delete' ? (
                                <ActivityIndicator size="small" />
                            ) : (
                                <Text style={[styles.bulkToolbarButtonText, styles.bulkToolbarDangerText]}>{t('sessionInfo.bulkDeleteSessions')}</Text>
                            )}
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            disabled={bulkProcessing !== null}
                            onPress={clearSelection}
                            style={styles.bulkToolbarButton}
                        >
                            <Feather name="x" size={18} color={theme.colors.text} />
                        </Pressable>
                    </View>
                )}
            </View>
        </View>
    );
}

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean }> = {
    idle: { color: '#6B7280', dotColor: '#9CA3AF', isPulsing: false },
    running: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true },
    failed: { color: '#FF3B30', dotColor: '#FF3B30', isPulsing: false },
    completed: { color: '#34C759', dotColor: '#34C759', isPulsing: false },
};

const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle, bulkSelected, selectionMode, onStartSelection, onToggleSelection }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    bulkSelected?: boolean;
    selectionMode?: boolean;
    onStartSelection?: (sessionId: string) => void;
    onToggleSelection?: (sessionId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const disclosure = useSessionRowDisclosure(session.name);
    const presentation = useSessionRowPresentation(session);
    const baseStatus = STATUS_CONFIG[session.state];
    // Override to solid blue when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, dotColor: theme.colors.accent, isPulsing: false }
        : baseStatus;
    const statusText = `${getSessionStateLabel(session.state)}${session.isConnected ? '' : ` · ${t('status.disconnected')}`}`;

    const handlePress = React.useCallback(() => {
        if (selectionMode) {
            onToggleSelection?.(session.id);
            return;
        }
        navigateToSession(session.id);
    }, [navigateToSession, onToggleSelection, selectionMode, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    // Native long-press: anchor the context menu at the touch point instead of
    // showing a centered alert. pageX/pageY come from the gesture responder event.
    const handleLongPress = React.useCallback((event: any) => {
        hapticsLight();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : selectionMode ? {} : {
        onLongPress: handleLongPress,
    };

    const titleHint = Platform.OS === 'web' && disclosure.titleOverflowing
        ? { title: session.name } as any
        : {};

    return (
        <View style={[
            styles.sessionItemContainer,
            (disclosure.visible || !!actionsAnchor) && styles.sessionItemContainerRaised,
            isSingle ? styles.sessionItemContainerSingle :
                isFirst ? styles.sessionItemContainerFirst :
                    isLast ? styles.sessionItemContainerLast : {}
        ]} ref={disclosure.wrapperRef} {...disclosure.interactionProps as any}>
        <View
            style={[
                styles.sessionItem,
                (selected || bulkSelected || !!actionsAnchor) && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
        >
            <Pressable
                accessibilityLabel={`${session.name}, ${statusText}`}
                accessibilityRole="button"
                accessibilityState={{ selected: !!selected }}
                aria-current={selected ? 'page' : undefined}
                focusable
                onPress={handlePress}
                style={styles.sessionPressTarget}
                testID={`session-row-${session.id}`}
                {...menuProps}
            >
            <View style={styles.avatarContainer}>
                {selectionMode ? (
                    <View style={[styles.selectionCheckbox, bulkSelected && styles.selectionCheckboxSelected]}>
                        {bulkSelected ? (
                            <Feather
                                name="check"
                                size={14}
                                color="#FFFFFF"
                            />
                        ) : null}
                    </View>
                ) : (
                    <Avatar id={session.avatarId} size={48} monochrome={!session.isConnected} flavor={session.flavor} />
                )}
                {!selectionMode && session.hasDraft && (
                    <View style={styles.draftIconContainer}>
                        <Feather
                            name="edit-3"
                            size={13}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        session.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1} testID="session-row-title" {...titleHint}>
                        {session.name}
                    </Text>
                </View>

                <SessionRowLocation presentation={presentation} />

                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                    </View>
                    <Text style={[
                        styles.statusText,
                        { color: status.color }
                    ]}>
                        {statusText}
                    </Text>
                </View>
            </View>
            </Pressable>
            {!selectionMode ? (
                <SessionRowActions
                    contextAnchor={actionsAnchor}
                    onContextAnchorChange={setActionsAnchor}
                    onStartSelection={onStartSelection ? () => onStartSelection(session.id) : undefined}
                    sessionId={session.id}
                    statusLabel={presentation.status}
                    visible={disclosure.visible}
                />
            ) : null}
        </View>
        <SessionRowDetails
            anchor={disclosure.detailsAnchor}
            presentation={presentation}
            visible={!selectionMode && disclosure.visible}
        />
        </View>
    );
});
