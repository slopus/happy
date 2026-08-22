import React from 'react';
import { Platform, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ProjectGroupData, ProjectWorkspaceGroup } from '@/sync/storage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Avatar } from './Avatar';

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
}

/**
 * One project and its sessions, split into the primary checkout and any named
 * worktrees reported by Rig or created through Happy.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId }: ProjectGroupProps) => {
    const styles = stylesheet;
    const firstSession = project.workspaces[0]?.sessions[0];

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {firstSession && (
                    <Avatar id={firstSession.avatarId} size={24} flavor={null} />
                )}
                <Text style={styles.title} numberOfLines={1}>
                    {project.name}
                </Text>
            </View>

            {project.workspaces.map((workspace) => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    workspace={workspace}
                    selectedSessionId={selectedSessionId}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ workspace, selectedSessionId }: {
    workspace: ProjectWorkspaceGroup;
    selectedSessionId?: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.workspaceCard}>
            <View style={styles.workspaceHeader}>
                <MaterialCommunityIcons
                    name={workspace.id ? 'source-branch' : 'folder-outline'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
                <Text style={styles.workspaceTitle} numberOfLines={1}>
                    {workspace.name ?? (workspace.id || 'main')}
                </Text>
            </View>
            {workspace.sessions.map((session, index) => (
                <CompactSessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    showBorder={index < workspace.sessions.length - 1}
                />
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: 'transparent',
        marginBottom: 4,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        gap: 8,
    },
    title: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        ...Typography.default('regular'),
    },
    workspaceCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        marginBottom: 8,
        borderRadius: Platform.select({ web: 16, default: 18 }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: 'transparent' }),
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 0 }),
        shadowRadius: 0,
        elevation: Platform.select({ web: 1, default: 0 }),
    },
    workspaceHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 16,
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
