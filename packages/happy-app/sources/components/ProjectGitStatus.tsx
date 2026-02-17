import React from 'react';
import { View, Text } from 'react-native';
import { useProjectGitStatusByKey, useSessionProjectGitStatus } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { getAddedLines, getRemovedLines, hasLoadedGitStatus } from '@/sync/gitStatusUtils';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        maxWidth: 150,
    },
    branchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    branchIcon: {
        marginRight: 4,
        flexShrink: 0,
    },
    branchText: {
        fontSize: 13,
        fontWeight: '500',
        color: theme.colors.groupped.sectionTitle,
        flexShrink: 1,
        minWidth: 0,
    },
    changesContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 6,
        flexShrink: 0,
    },
    filesText: {
        fontSize: 11,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        marginRight: 4,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    addedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
    },
    removedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
    },
}));

interface ProjectGitStatusProps {
    /** Session-scoped lookup (backward compatible) */
    sessionId?: string;
    /** Exact project key lookup (preferred) */
    machineId?: string;
    path?: string;
}

export function ProjectGitStatus({ sessionId, machineId, path }: ProjectGitStatusProps) {
    const styles = stylesheet;
    const keyGitStatus = useProjectGitStatusByKey(machineId || null, path || null);
    const sessionGitStatus = useSessionProjectGitStatus(sessionId || null);
    const gitStatus = keyGitStatus || sessionGitStatus;

    // Don't render if no git status (not a git repository)
    if (!hasLoadedGitStatus(gitStatus)) {
        return null;
    }

    const addedLines = getAddedLines(gitStatus);
    const removedLines = getRemovedLines(gitStatus);
    const hasLineChanges = addedLines > 0 || removedLines > 0;

    return (
        <View style={styles.container}>
            {/* Show total line changes (staged + unstaged) */}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {addedLines > 0 && (
                        <Text style={styles.addedText}>
                            +{addedLines}
                        </Text>
                    )}
                    {removedLines > 0 && (
                        <Text style={styles.removedText}>
                            -{removedLines}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
