import React from 'react';
import { View, Text } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { GitStatus } from '@/sync/storageTypes';
import { useUnistyles } from 'react-native-unistyles';

// Custom hook to check if git status should be shown (always true if git repo exists)
export function useHasMeaningfulGitStatus(sessionId: string): boolean {
    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    return gitStatus ? gitStatus.lastUpdatedAt > 0 : false;
}

interface GitStatusBadgeProps {
    sessionId: string;
}

export function GitStatusBadge({ sessionId }: GitStatusBadgeProps) {
    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    const { theme } = useUnistyles();

    // Always show if git repository exists, even without changes
    if (!gitStatus || gitStatus.lastUpdatedAt === 0) {
        return null;
    }

    const hasLineChanges = gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Git icon - always shown */}
            <Octicons
                name="git-branch"
                size={16}
                color={theme.colors.button.secondary.tint}
            />

            {/* Line changes only */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {gitStatus.unstagedLinesAdded > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitAddedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            +{gitStatus.unstagedLinesAdded}
                        </Text>
                    )}
                    {gitStatus.unstagedLinesRemoved > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitRemovedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            -{gitStatus.unstagedLinesRemoved}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}

function getTotalChangedFiles(status: GitStatus): number {
    return status.modifiedCount + status.untrackedCount + status.stagedCount;
}

function hasMeaningfulChanges(status: GitStatus): boolean {
    // Must have been loaded (lastUpdatedAt > 0) and be dirty and have either file changes or line changes
    return status.lastUpdatedAt > 0 && status.isDirty && (
        getTotalChangedFiles(status) > 0 ||
        status.unstagedLinesAdded > 0 ||
        status.unstagedLinesRemoved > 0
    );
}