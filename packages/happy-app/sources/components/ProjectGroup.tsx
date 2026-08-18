import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ProjectGroupData, ProjectWorkspaceGroup, useAllMachines } from '@/sync/storage';
import { SessionListRow } from './SessionListRow';
import { sessionRowLayout } from './sessionRowLayout';

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
    const machines = useAllMachines();

    const machineName = React.useMemo(() => {
        if (!project.machineId) return null;
        const machine = machines.find(m => m.id === project.machineId);
        return machine?.metadata?.displayName || machine?.metadata?.host || null;
    }, [machines, project.machineId]);

    // Worktrees only need naming when the project actually has more than one
    const showWorkspaceLabels = project.workspaces.length > 1;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title} numberOfLines={1}>
                    {project.name}
                </Text>
                {machineName && (
                    <Text style={styles.machine} numberOfLines={1}>
                        {machineName}
                    </Text>
                )}
            </View>

            {project.workspaces.map(workspace => (
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
                <SessionListRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    showDivider={index < workspace.sessions.length - 1}
                />
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: 'transparent',
        marginBottom: 6,
    },
    // Same metrics as the "Pinned" / "Today" headings in SessionsList — a
    // project name is a section heading, nothing more.
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: sessionRowLayout.gutter,
        paddingTop: 20,
        paddingBottom: 6,
        gap: 6,
    },
    title: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.groupped.sectionTitle,
        flexShrink: 1,
        ...Typography.default(),
    },
    machine: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    workspace: {
        paddingLeft: 0,
    },
    workspaceHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingLeft: sessionRowLayout.textInset,
        paddingRight: sessionRowLayout.gutter,
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
