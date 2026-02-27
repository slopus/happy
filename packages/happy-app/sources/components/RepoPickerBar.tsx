import React, { useMemo, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { storage } from '@/sync/storage';
import type { RegisteredRepo } from '@/utils/workspaceRepos';

// --- Public types ---

export interface SelectedRepo {
    repo: RegisteredRepo | { path: string; displayName: string };
    targetBranch?: string;
}

interface RepoPickerBarProps {
    machineId: string;
    selectedRepos: SelectedRepo[];
    onReposChange: (repos: SelectedRepo[]) => void;
}

// --- Helpers ---

/** Stable identity key for a repo (registered repos have `id`, ad-hoc ones use `path`). */
const repoKey = (repo: SelectedRepo['repo']): string =>
    'id' in repo && repo.id ? repo.id : repo.path;

// --- Component ---

/**
 * RepoPickerBar – lets users select repositories for a multi-repo workspace.
 *
 * Shows registered repos for the given machine sorted by most-recently-used,
 * highlights the ones that are already selected, and provides an
 * "Add directory..." action so the parent can trigger a directory browser.
 */
export const RepoPickerBar: React.FC<RepoPickerBarProps> = React.memo(
    ({ machineId, selectedRepos, onReposChange }) => {
        // Registered repos for the machine, sorted by lastUsedAt (most recent first)
        const registeredRepos = useMemo(() => {
            const repos = storage.getState().registeredRepos[machineId] || [];
            return [...repos].sort(
                (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
            );
        }, [machineId]);

        // Set of selected keys for O(1) lookup
        const selectedKeys = useMemo(
            () => new Set(selectedRepos.map((s) => repoKey(s.repo))),
            [selectedRepos],
        );

        const toggleRepo = useCallback(
            (repo: RegisteredRepo) => {
                const key = repoKey(repo);
                if (selectedKeys.has(key)) {
                    onReposChange(selectedRepos.filter((s) => repoKey(s.repo) !== key));
                } else {
                    onReposChange([...selectedRepos, { repo }]);
                }
            },
            [selectedRepos, selectedKeys, onReposChange],
        );

        const removeRepo = useCallback(
            (key: string) => {
                onReposChange(selectedRepos.filter((s) => repoKey(s.repo) !== key));
            },
            [selectedRepos, onReposChange],
        );

        const handleAddDirectory = useCallback(() => {
            // Append a placeholder entry – the parent is responsible for replacing
            // this with an actual path once the user picks a directory.
            onReposChange([
                ...selectedRepos,
                { repo: { path: '', displayName: '' } },
            ]);
        }, [selectedRepos, onReposChange]);

        return (
            <View style={stylesheet.container}>
                {/* Registered repo chips */}
                {registeredRepos.map((repo) => {
                    const key = repoKey(repo);
                    const isSelected = selectedKeys.has(key);
                    return (
                        <Pressable
                            key={key}
                            onPress={() => toggleRepo(repo)}
                            style={[
                                stylesheet.chip,
                                isSelected && stylesheet.chipSelected,
                            ]}
                        >
                            <Text
                                style={[
                                    stylesheet.chipText,
                                    isSelected && stylesheet.chipTextSelected,
                                ]}
                                numberOfLines={1}
                            >
                                {repo.displayName}
                            </Text>
                            {isSelected && (
                                <Pressable
                                    onPress={() => removeRepo(key)}
                                    style={stylesheet.removeButton}
                                    hitSlop={6}
                                >
                                    <Ionicons
                                        name="close-circle"
                                        size={16}
                                        color={stylesheet.removeIcon?.color as string}
                                    />
                                </Pressable>
                            )}
                        </Pressable>
                    );
                })}

                {/* Selected ad-hoc repos (unregistered directories) */}
                {selectedRepos
                    .filter((s) => !('id' in s.repo && s.repo.id))
                    .filter((s) => s.repo.path !== '') // skip empty placeholders
                    .map((s) => {
                        const key = repoKey(s.repo);
                        return (
                            <View key={key} style={[stylesheet.chip, stylesheet.chipSelected]}>
                                <Text style={[stylesheet.chipText, stylesheet.chipTextSelected]} numberOfLines={1}>
                                    {s.repo.displayName || s.repo.path}
                                </Text>
                                <Pressable
                                    onPress={() => removeRepo(key)}
                                    style={stylesheet.removeButton}
                                    hitSlop={6}
                                >
                                    <Ionicons
                                        name="close-circle"
                                        size={16}
                                        color={stylesheet.removeIcon?.color as string}
                                    />
                                </Pressable>
                            </View>
                        );
                    })}

                {/* Add directory action */}
                <Pressable onPress={handleAddDirectory} style={stylesheet.addChip}>
                    <Ionicons
                        name="add-circle-outline"
                        size={16}
                        color={stylesheet.addIcon?.color as string}
                    />
                    <Text style={stylesheet.addChipText}>
                        {t('newSession.repos.addDirectory')}
                    </Text>
                </Pressable>
            </View>
        );
    },
);

// --- Styles ---

const stylesheet = StyleSheet.create((theme, _rt) => ({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surfaceHigh,
    },
    chipSelected: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    chipText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        maxWidth: 180,
    },
    chipTextSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    removeButton: {
        marginLeft: 6,
        padding: 2,
    },
    removeIcon: {
        // Style-as-data: the color is read imperatively by the component.
        color: theme.colors.deleteAction,
    },
    addChip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 4,
    },
    addIcon: {
        // Style-as-data: the color is read imperatively by the component.
        color: theme.colors.textSecondary,
    },
    addChipText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
}));
