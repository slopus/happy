import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { ProjectGroupData, ProjectWorkspaceGroup, useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { seedNewSessionDraftFrom } from '@/utils/newSessionFromProject';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
}

/**
 * One project and its sessions. Rig projects may contain named worktrees;
 * Happy CLI projects use a single workspace derived from their working path.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId }: ProjectGroupProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const [collapsedProjects, setCollapsedProjects] = useLocalSettingMutable('collapsedProjects');
    const collapsed = !!collapsedProjects[project.id];

    const toggleCollapsed = React.useCallback(() => {
        setCollapsedProjects({ ...collapsedProjects, [project.id]: !collapsed });
    }, [collapsed, collapsedProjects, project.id, setCollapsedProjects]);

    const machineName = React.useMemo(() => {
        if (!project.machineId) return null;
        const machine = machines.find(m => m.id === project.machineId);
        return machine?.metadata?.displayName || machine?.metadata?.host || null;
    }, [machines, project.machineId]);

    // Worktrees only need naming when the project actually has more than one
    const showWorkspaceLabels = project.workspaces.length > 1;

    // A card carries no working directory of its own — the cards keyed by path
    // are grouped on (machine, path), so every session under one shares both and
    // any of them answers "where would a new session here run".
    const seedSession = React.useMemo(
        () => project.workspaces.flatMap(w => w.sessions).find(s => s.path) ?? null,
        [project.workspaces],
    );
    const router = useRouter();
    const handleNewSession = React.useCallback(() => {
        if (!seedSession) return;
        seedNewSessionDraftFrom(seedSession);
        router.navigate('/new');
    }, [router, seedSession]);

    return (
        <View style={styles.container}>
            <Pressable style={styles.header} onPress={toggleCollapsed} hitSlop={8}>
                <Ionicons
                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={16}
                    color={theme.colors.textSecondary}
                    style={styles.chevron}
                />
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {project.name}
                    </Text>
                    {machineName && (
                        <Text style={styles.subtitle} numberOfLines={1}>
                            {machineName}
                        </Text>
                    )}
                </View>
                {seedSession && (
                    <Pressable
                        onPress={handleNewSession}
                        hitSlop={{ top: 15, bottom: 15, left: 8, right: 8 }}
                        style={styles.addButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('sidebar.newSession')}
                    >
                        <Ionicons name="add" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
                <Text style={styles.count}>
                    {project.activeCount > 0 ? `${project.activeCount}/${project.sessionCount}` : project.sessionCount}
                </Text>
            </Pressable>

            {!collapsed && project.workspaces.map(workspace => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    workspace={workspace}
                    showLabel={showWorkspaceLabels}
                    selectedSessionId={selectedSessionId}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ workspace, showLabel, selectedSessionId }: {
    workspace: ProjectWorkspaceGroup;
    showLabel: boolean;
    selectedSessionId?: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.workspace}>
            {showLabel && (
                <View style={styles.workspaceHeader}>
                    <Ionicons
                        name={workspace.name ? 'git-branch-outline' : 'folder-outline'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                    <Text style={styles.workspaceTitle} numberOfLines={1}>
                        {workspace.name ?? 'main'}
                    </Text>
                </View>
            )}
            {workspace.sessions.map((session, index) => (
                <CompactSessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    showBorder={index > 0}
                />
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: 8,
        marginBottom: 8,
        borderRadius: 12,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
    },
    chevron: {
        width: 16,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
        ...Typography.default(),
    },
    addButton: {
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    count: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    workspace: {
        paddingLeft: 10,
    },
    workspaceHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    workspaceTitle: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));
