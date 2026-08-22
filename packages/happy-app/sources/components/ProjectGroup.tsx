import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ProjectGroupData, ProjectWorkspaceGroup } from '@/sync/storage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Avatar } from './Avatar';
import { requestHomeDockFocus } from './homeDockFocus';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
}

/**
 * One project and its sessions, split into the primary checkout and any named
 * worktrees reported by Rig or created through Happy. Each worktree gets its
 * own header and card: the worktree name reads as a second line under the
 * project, so the card itself stays a plain list of sessions.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId }: ProjectGroupProps) => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            {project.workspaces.map((workspace) => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    project={project}
                    workspace={workspace}
                    selectedSessionId={selectedSessionId}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ project, workspace, selectedSessionId }: {
    project: ProjectGroupData;
    workspace: ProjectWorkspaceGroup;
    selectedSessionId?: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const firstSession = workspace.sessions[0];
    // The primary checkout is the project itself, so naming it twice adds
    // nothing. Only a real worktree earns the second line.
    const worktreeName = workspace.name ?? (workspace.id || null);

    // Point the draft at this exact checkout before opening the composer, so
    // the dock's machine, project and worktree rows already read correctly.
    // `setMachineId` clears the path and worktree, so the order matters.
    const handleNewSession = React.useCallback(() => {
        const draft = useNewSessionDraft.getState();
        const sessionPath = firstSession?.path ?? '';
        const worktree = isWorktreePath(sessionPath);
        const repoPath = worktree ? getRepoPath(sessionPath) : sessionPath;

        if (firstSession?.machineId) {
            draft.setMachineId(firstSession.machineId);
        }
        if (repoPath) {
            draft.setPath(formatPathRelativeToHome(repoPath, firstSession?.homeDir ?? undefined));
        }
        draft.setSessionType(worktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktree ? sessionPath : null);

        // Nothing is listening in the sidebar layout or on web, where the dock
        // is never mounted; those fall back to the standalone screen.
        if (!requestHomeDockFocus()) {
            router.navigate('/new');
        }
    }, [firstSession, router]);

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                {firstSession && (
                    <Avatar id={firstSession.avatarId} size={24} flavor={null} />
                )}
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {project.name}
                    </Text>
                    {worktreeName && (
                        <View style={styles.worktreeRow}>
                            <Text style={styles.worktreeTitle} numberOfLines={1}>
                                {worktreeName}
                            </Text>
                            <MaterialCommunityIcons
                                name="source-branch"
                                size={11}
                                color={theme.colors.textSecondary}
                            />
                        </View>
                    )}
                </View>
                <Pressable
                    onPress={handleNewSession}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.newSession')}
                    style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
                >
                    <Ionicons name="add" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.workspaceCard}>
                {workspace.sessions.map((session, index) => (
                    <CompactSessionRow
                        key={session.id}
                        session={session}
                        selected={session.id === selectedSessionId}
                        showBorder={index < workspace.sessions.length - 1}
                    />
                ))}
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: 'transparent',
        marginBottom: 4,
    },
    section: {
        backgroundColor: 'transparent',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        gap: 8,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        ...Typography.default('regular'),
    },
    worktreeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    worktreeTitle: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    addButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addButtonPressed: {
        opacity: 0.5,
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
}));
