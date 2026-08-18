import React from 'react';
import { View, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { filterProjectGroup, sessionMatchesQuery } from '@/sync/projectGroups';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { ProjectGroup } from './ProjectGroup';
import { SessionListRow } from './SessionListRow';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { sessionRowLayout } from './sessionRowLayout';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { t } from '@/text';

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
        paddingHorizontal: sessionRowLayout.gutter,
        paddingTop: 20,
        paddingBottom: 6,
    },
    headerText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default(),
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
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
}));

export function SessionsList({
    topContentInset = 0,
    bottomContentInset = 128,
    onScroll,
    searchQuery = '',
    items,
    emptyComponent,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    searchQuery?: string;
    /** Rows to render. Defaults to the main list; the archive screen passes its own. */
    items?: SessionListViewItem[] | null;
    emptyComponent?: React.ReactElement | null;
} = {}) {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    // Always called — hook order cannot depend on which list this is — and
    // ignored when the caller supplies its own rows.
    const mainListData = useVisibleSessionListViewData();
    const sourceData = items !== undefined ? items : mainListData;
    const pathname = usePathname();
    const isTablet = useIsTablet();
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
            if (project) {
                keptProjects.set(index, { ...item, project });
            }
        });

        const keepIndices = new Set<number>();
        let currentHeaderIndex: number | null = null;
        let currentProjectIndex: number | null = null;

        sourceData.forEach((item, index) => {
            if (item.type === 'section') {
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
            if (item.type === 'project') {
                const kept = keptProjects.get(index);
                if (kept) result.push(kept);
                return;
            }
            if (keepIndices.has(index)) result.push(item);
        });
        return result;
    }, [searchQuery, sourceData]);

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'section': return `section-${item.title}`;
            case 'active-sessions': return 'active-sessions';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'project': return `project-${item.project.id}`;
            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem, index: number }) => {
        switch (item.type) {
            case 'section':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>{item.title}</Text>
                    </View>
                );
            case 'active-sessions':
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                    />
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
                // Rows run flat under their section heading, so the only
                // position that matters is whether another row follows: the
                // last one closes the group instead of drawing a divider.
                const nextItem = data?.[index + 1] ?? null;
                const isLast = nextItem?.type !== 'session';
                const selected = item.session.id === selectedSessionId;

                return (
                    <SessionListRow
                        session={item.session}
                        selected={selected}
                        showDivider={!isLast}
                    />
                );
        }
    }, [selectedSessionId, data]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <UpdateBanner />
        );
    }, []);

    // Guard placed after every hook: bailing out earlier changed the hook count
    // between the first (data === null) render and the next one, which React
    // rejects outright once sessions arrive.
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={selectedSessionId}
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
                    ) : emptyComponent ?? null}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                />
            </View>
        </View>
    );
}
