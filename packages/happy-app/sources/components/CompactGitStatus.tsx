import React from 'react';
import { View, Text } from 'react-native';
import { useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { getAddedLines, getRemovedLines, hasMeaningfulLineChanges } from '@/sync/gitStatusUtils';

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
    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;

    // Don't render if no git status or no meaningful changes
    if (!hasMeaningfulLineChanges(gitStatus)) {
        return null;
    }

    const addedLines = getAddedLines(gitStatus);
    const removedLines = getRemovedLines(gitStatus);

    return (
        <View style={styles.container}>
            <Ionicons
                name="git-branch-outline"
                size={10}
                color={styles.fileCountText.color}
                style={{ marginRight: 2 }}
            />

            {/* Show total line changes in compact format */}
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
        </View>
    );
}
