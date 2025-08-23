import React from 'react';
import { View, Text } from 'react-native';
import { useSessionGitStatus } from '@/sync/storage';
import { GitStatus } from '@/sync/storageTypes';
import { useUnistyles } from 'react-native-unistyles';

// Custom hook to check if git status should be shown
export function useHasMeaningfulGitStatus(sessionId: string): boolean {
    const gitStatus = useSessionGitStatus(sessionId);
    return gitStatus ? hasMeaningfulChanges(gitStatus) : false;
}

interface GitStatusBadgeProps {
    sessionId: string;
}

export function GitStatusBadge({ sessionId }: GitStatusBadgeProps) {
    const gitStatus = useSessionGitStatus(sessionId);
    const { theme } = useUnistyles();

    // Don't render if no git status (not a git repository) or no meaningful changes
    if (!gitStatus || !hasMeaningfulChanges(gitStatus)) {
        return null;
    }

    const fileCount = getTotalChangedFiles(gitStatus);
    const hasLineChanges = gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* Branch name */}
            <Text style={{
                fontSize: 12,
                color: theme.colors.button.secondary.tint,
                fontWeight: '500'
            }}>
                {gitStatus.branch || 'main'}
            </Text>

            {/* Files changed - only show if there are files */}
            {fileCount > 0 && (
                <Text style={{
                    fontSize: 12,
                    color: theme.colors.button.secondary.tint,
                    fontWeight: '500'
                }}>
                    {fileCount} files
                </Text>
            )}

            {/* Line changes - GitHub style */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {gitStatus.unstagedLinesAdded > 0 && (
                        <Text style={{
                            fontSize: 12,
                            color: theme.colors.gitAddedText,
                            fontWeight: '600'
                        }}>
                            +{gitStatus.unstagedLinesAdded}
                        </Text>
                    )}
                    {gitStatus.unstagedLinesRemoved > 0 && (
                        <Text style={{
                            fontSize: 12,
                            color: theme.colors.gitRemovedText,
                            fontWeight: '600'
                        }}>
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