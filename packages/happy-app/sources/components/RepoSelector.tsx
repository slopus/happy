import React from 'react';
import { View, Pressable, Text, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { WorkspaceRepo } from '@/utils/workspaceRepos';

interface RepoSelectorProps {
    repos: WorkspaceRepo[];
    selectedIndex: number;
    onSelect: (index: number) => void;
}

/**
 * Horizontal pill/tab selector for switching between repos in a workspace.
 * Hidden when repos.length <= 1.
 */
export function RepoSelector({ repos, selectedIndex, onSelect }: RepoSelectorProps) {
    if (repos.length <= 1) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.container}
        >
            {repos.map((repo, index) => (
                <Pressable
                    key={index}
                    onPress={() => onSelect(index)}
                    style={[styles.pill, index === selectedIndex && styles.pillSelected]}
                >
                    <Text style={[styles.pillText, index === selectedIndex && styles.pillTextSelected]}>
                        {repo.displayName || repo.basePath.split('/').pop() || `Repo ${index + 1}`}
                    </Text>
                </Pressable>
            ))}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    pill: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surfaceHigh,
    },
    pillSelected: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    pillText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    pillTextSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));
