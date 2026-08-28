import React from 'react';
import { ActivityIndicator, View, Pressable, FlatList } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem } from '@/sync/storage';
import { Feather } from '@expo/vector-icons';
import { ActiveSessionsGroupCompact, CompactSessionRow } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { storage, useSettingMutable } from '@/sync/storage';
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
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    headerText: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: 13,
        lineHeight: 18,
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
}));

export function SessionsList({ layoutMode = 'projects' }: { layoutMode?: 'projects' | 'time' }) {
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

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem }) => {
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
                        layoutMode={layoutMode}
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
                return (
                    <CompactSessionRow
                        session={item.session}
                        selected={item.session.id === selectedSessionId}
                        bulkSelected={selectedIds.has(item.session.id)}
                        selectionMode={selectionMode}
                        showLocation
                        onStartSelection={startSelection}
                        onToggleSelection={toggleSelection}
                    />
                );
        }
    }, [layoutMode, selectedSessionId, toggleArchived, selectionMode, selectedIds, startSelection, toggleSelection]);


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
