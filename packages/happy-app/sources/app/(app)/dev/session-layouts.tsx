import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ProjectGroup } from '@/components/ProjectGroup';
import { ProjectSection } from '@/components/ProjectSection';
import { StatusDot } from '@/components/StatusDot';
import { Switch } from '@/components/Switch';
import { filterProjectGroupSessions, type ProjectGroupData } from '@/sync/projectGroups';
import type { SessionRowData } from '@/sync/storage';
import {
    fixtureHappyProjects,
    fixtureMachineNames,
    fixtureRigProjects,
} from '@/sync/__testdata__/sessionListFixtures';
import { formatLastSeen } from '@/utils/sessionUtils';

/**
 * Sandbox for sessions-list layout candidates. Everything here runs on fake
 * data from `sessionListFixtures` so layouts can be compared side by side
 * without a machine connected. Dev page — no i18n.
 */

type LayoutKey = 'current' | 'sections' | 'feed' | 'rail';

const LAYOUTS: { key: LayoutKey; label: string; note: string }[] = [
    { key: 'current', label: 'Now', note: 'Card → worktree → session, provider + model on every row' },
    { key: 'sections', label: 'A · Sections', note: 'Plain section header + one flat card. Worktree becomes a trailing label' },
    { key: 'feed', label: 'B · Feed', note: 'No project grouping at all — time buckets, project shown as a breadcrumb' },
    { key: 'rail', label: 'C · Rail', note: 'Keeps the card, drops the worktree level and the identity line' },
];

export default function SessionLayoutsScreen() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const [layout, setLayout] = React.useState<LayoutKey>('sections');
    const [hideInactive, setHideInactive] = React.useState(true);

    const rig = useVisibleProjects(fixtureRigProjects, hideInactive);
    const happy = useVisibleProjects(fixtureHappyProjects, hideInactive);
    const allProjects = React.useMemo(() => [...rig, ...happy], [happy, rig]);
    const machineName = useMachineNameResolver(allProjects);
    const active = LAYOUTS.find((item) => item.key === layout)!;

    return (
        <View style={styles.screen}>
            <View style={styles.toolbar}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
                    {LAYOUTS.map((item) => (
                        <Pressable
                            key={item.key}
                            onPress={() => setLayout(item.key)}
                            style={[styles.tab, layout === item.key && styles.tabActive]}
                        >
                            <Text style={[styles.tabText, layout === item.key && styles.tabTextActive]}>
                                {item.label}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>
                <View style={styles.toggleRow}>
                    <Text style={styles.toggleLabel}>Hide inactive</Text>
                    <Switch value={hideInactive} onValueChange={setHideInactive} />
                </View>
                <Text style={styles.note}>{active.note}</Text>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: safeArea.bottom + 48 }}>
                {layout === 'feed' ? (
                    <FeedLayout projects={allProjects} />
                ) : (
                    <>
                        <SourceHeader title="Rig" />
                        {rig.map((project) => (
                            <LayoutBody key={project.id} layout={layout} project={project} machineName={machineName(project)} />
                        ))}
                        <SourceHeader title="Happy" />
                        {happy.map((project) => (
                            <LayoutBody key={project.id} layout={layout} project={project} machineName={machineName(project)} />
                        ))}
                    </>
                )}
            </ScrollView>
        </View>
    );
}

function SourceHeader({ title }: { title: string }) {
    const styles = stylesheet;
    return (
        <View style={styles.sourceHeader}>
            <Text style={styles.sourceHeaderText}>{title}</Text>
        </View>
    );
}

function LayoutBody({ layout, project, machineName }: { layout: LayoutKey; project: ProjectGroupData; machineName: string | null }) {
    if (layout === 'current') {
        return <ProjectGroup project={project} />;
    }
    if (layout === 'rail') {
        return <RailProject project={project} machineName={machineName} />;
    }
    return <ProjectSection project={project} machineName={machineName} onPressSession={() => {}} />;
}

/* ------------------------------------------------------------------ */
/* B · Feed — sessions only, bucketed by recency, project as breadcrumb */
/* ------------------------------------------------------------------ */

function FeedLayout({ projects }: { projects: ProjectGroupData[] }) {
    const styles = stylesheet;
    const rows = React.useMemo(() => {
        const all = projects.flatMap((project) =>
            project.workspaces.flatMap((workspace) =>
                workspace.sessions.map((session) => ({
                    session,
                    project: project.name,
                    worktree: project.workspaces.length > 1 ? (workspace.name ?? 'main') : null,
                })),
            ),
        );
        return {
            live: all.filter((row) => row.session.state === 'thinking' || row.session.state === 'permission_required' || row.session.hasUnread),
            idle: all.filter((row) => row.session.active && !(row.session.state === 'thinking' || row.session.state === 'permission_required' || row.session.hasUnread)),
            past: all.filter((row) => !row.session.active),
        };
    }, [projects]);

    return (
        <View>
            {([['Needs you', rows.live], ['Open', rows.idle], ['Earlier', rows.past]] as const).map(([title, items]) => (
                items.length === 0 ? null : (
                    <View key={title}>
                        <View style={styles.feedBucket}>
                            <Text style={styles.feedBucketText}>{title}</Text>
                        </View>
                        <View style={styles.feedCard}>
                            {items.map((row, index) => (
                                <FeedRow key={row.session.id} row={row} showBorder={index > 0} />
                            ))}
                        </View>
                    </View>
                )
            ))}
        </View>
    );
}

function FeedRow({ row, showBorder }: {
    row: { session: SessionRowData; project: string; worktree: string | null };
    showBorder: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { session } = row;
    const connected = session.state !== 'disconnected';
    const dotColor = session.hasUnread
        ? '#007AFF'
        : session.state === 'thinking'
            ? '#007AFF'
            : session.state === 'permission_required'
                ? '#FF9500'
                : theme.colors.textSecondary;

    return (
        <View style={[styles.feedRow, showBorder && styles.rowBorder]}>
            <View style={styles.indicatorSlot}>
                {connected ? <StatusDot color={dotColor} isPulsing={session.state === 'thinking' || session.state === 'permission_required'} /> : null}
            </View>
            <View style={styles.feedRowBody}>
                <Text style={[styles.feedTitle, !connected && styles.dimmed]} numberOfLines={1}>
                    {session.name}
                </Text>
                <Text style={styles.feedMeta} numberOfLines={1}>
                    {row.project}{row.worktree ? ` · ${row.worktree}` : ''}
                </Text>
            </View>
            <Text style={styles.feedTime}>
                {connected ? '' : formatLastSeen(session.activeAt ?? Date.now(), false)}
            </Text>
        </View>
    );
}

/* --------------------------------------------------- */
/* C · Rail — today's card, minus a level and the noise */
/* --------------------------------------------------- */

function RailProject({ project, machineName }: { project: ProjectGroupData; machineName: string | null }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [collapsed, setCollapsed] = React.useState(false);
    const showWorktrees = project.workspaces.length > 1;

    return (
        <View style={styles.railCard}>
            <Pressable style={styles.railHeader} onPress={() => setCollapsed((value) => !value)} hitSlop={8}>
                <Ionicons
                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
                <Text style={styles.railTitle} numberOfLines={1}>{project.name}</Text>
                {machineName ? <Text style={styles.railMachine} numberOfLines={1}>{machineName}</Text> : null}
                <View style={{ flex: 1 }} />
                {project.activeCount > 0 && (
                    <Text style={styles.railCount}>{project.activeCount}</Text>
                )}
            </Pressable>
            {!collapsed && project.workspaces.flatMap((workspace, workspaceIndex) => workspace.sessions.map((session, index) => (
                <View key={session.id} style={[styles.railRow, !(workspaceIndex === 0 && index === 0) && styles.rowBorder]}>
                    <View style={styles.indicatorSlot}>
                        {session.state !== 'disconnected' ? (
                            <StatusDot
                                color={session.state === 'permission_required' ? '#FF9500' : session.hasUnread || session.state === 'thinking' ? '#007AFF' : theme.colors.textSecondary}
                                isPulsing={session.state === 'thinking' || session.state === 'permission_required'}
                            />
                        ) : null}
                    </View>
                    <Text style={[styles.railRowTitle, session.state === 'disconnected' && styles.dimmed]} numberOfLines={1}>
                        {session.name}
                    </Text>
                    {showWorktrees && (
                        <View style={styles.branchChip}>
                            <Text style={styles.branchChipText} numberOfLines={1}>{workspace.name ?? 'main'}</Text>
                        </View>
                    )}
                </View>
            )))}
        </View>
    );
}

/* -------- */
/* Helpers  */
/* -------- */

function useVisibleProjects(projects: ProjectGroupData[], hideInactive: boolean): ProjectGroupData[] {
    return React.useMemo(() => {
        if (!hideInactive) return projects;
        return projects
            .map((project) => filterProjectGroupSessions(project, (session) => !session.archived))
            .filter((project): project is ProjectGroupData => !!project);
    }, [hideInactive, projects]);
}

/** Machine names only earn a slot once the list actually spans machines. */
function useMachineNameResolver(projects: ProjectGroupData[]) {
    return React.useMemo(() => {
        const machineIds = new Set(projects.map((project) => project.machineId ?? ''));
        return (project: ProjectGroupData) => (
            machineIds.size > 1 && project.machineId ? fixtureMachineNames[project.machineId] ?? project.machineId : null
        );
    }, [projects]);
}

const stylesheet = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    toolbar: {
        paddingTop: 10,
        paddingBottom: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    tabs: {
        paddingHorizontal: 12,
        gap: 6,
    },
    tab: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHigh,
    },
    tabActive: {
        backgroundColor: theme.colors.textLink,
    },
    tabText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    tabTextActive: {
        color: '#FFFFFF',
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 10,
    },
    toggleLabel: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    note: {
        paddingHorizontal: 16,
        paddingTop: 8,
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sourceHeader: {
        paddingHorizontal: 24,
        paddingTop: 18,
        paddingBottom: 2,
    },
    sourceHeaderText: {
        fontSize: 12,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    indicatorSlot: {
        width: 14,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowBorder: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    dimmed: {
        color: theme.colors.textSecondary,
    },
    // Feed
    feedBucket: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 16,
        paddingBottom: 6,
    },
    feedBucketText: {
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },
    feedCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: 14,
        overflow: 'hidden',
    },
    feedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 9,
    },
    feedRowBody: {
        flex: 1,
        minWidth: 0,
    },
    feedTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('regular'),
    },
    feedMeta: {
        marginTop: 1,
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    feedTime: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    // Rail
    railCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        marginTop: 8,
        borderRadius: 14,
        overflow: 'hidden',
    },
    railHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    railTitle: {
        fontSize: 14,
        color: theme.colors.text,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    railMachine: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    railCount: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    railRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        minHeight: 42,
    },
    railRowTitle: {
        flex: 1,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('regular'),
    },
    branchChip: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surfaceHigh,
        maxWidth: 150,
    },
    branchChipText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
