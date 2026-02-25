import React from 'react';
import { View, Text } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { getAddedLines, getRemovedLines, getUntrackedCount, hasLoadedGitStatus } from '@/sync/gitStatusUtils';

// Returns true once a git repository has been detected and status has loaded at least once.
export function useHasLoadedGitStatus(sessionId: string): boolean {
    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    return hasLoadedGitStatus(gitStatus);
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
    if (!hasLoadedGitStatus(gitStatus)) {
        return null;
    }

    const addedLines = getAddedLines(gitStatus);
    const removedLines = getRemovedLines(gitStatus);
    const untrackedCount = getUntrackedCount(gitStatus);
    const hasLineChanges = addedLines > 0 || removedLines > 0;
    const hasUntrackedChanges = untrackedCount > 0;
    const hasAnyChanges = hasLineChanges || hasUntrackedChanges;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Git icon - always shown */}
            <Octicons
                name="git-branch"
                size={16}
                color={theme.colors.button.secondary.tint}
            />

            {/* Total line changes (staged + unstaged) */}
            {hasAnyChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {addedLines > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitAddedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            +{addedLines}
                        </Text>
                    )}
                    {removedLines > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitRemovedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            -{removedLines}
                        </Text>
                    )}
                    {hasLineChanges && hasUntrackedChanges && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitFileCountText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            ·
                        </Text>
                    )}
                    {hasUntrackedChanges && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitFileCountText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            {untrackedCount}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
