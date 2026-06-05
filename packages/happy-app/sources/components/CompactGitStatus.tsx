import React from 'react';
import { View, Text } from 'react-native';
import { useSessionGitStatus } from '@/sync/storage';
import { GitStatus } from '@/sync/storageTypes';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 6,
        height: 16,
        borderRadius: 4,
    },
    fileCountText: {
        fontSize: 10,
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    addedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
    },
    removedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
    },
}));

interface CompactGitStatusProps {
    sessionId: string;
}

export function CompactGitStatus({ sessionId }: CompactGitStatusProps) {
    const styles = stylesheet;
    const gitStatus = useSessionGitStatus(sessionId);

    // Don't render if no git status or no meaningful changes
    if (!gitStatus || !hasMeaningfulChanges(gitStatus)) {
        return null;
    }

    const hasLineChanges = gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0;

    return (
        <View style={styles.container}>
            <Ionicons
                name="git-branch-outline"
                size={10}
                color={styles.fileCountText.color}
                style={{ marginRight: 2 }}
            />
            
            {/* Show line changes in compact format */}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {gitStatus.unstagedLinesAdded > 0 && (
                        <Text style={styles.addedText}>
                            +{gitStatus.unstagedLinesAdded}
                        </Text>
                    )}
                    {gitStatus.unstagedLinesRemoved > 0 && (
                        <Text style={styles.removedText}>
                            -{gitStatus.unstagedLinesRemoved}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}

function hasMeaningfulChanges(status: GitStatus): boolean {
    // Only show when there are actual line changes
    return status.lastUpdatedAt > 0 && status.isDirty && (
        status.unstagedLinesAdded > 0 ||
        status.unstagedLinesRemoved > 0
    );
}