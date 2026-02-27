import React, { useMemo, useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { storage } from '@/sync/storage';
import { machineBash } from '@/sync/ops';
import { Modal } from '@/modal';
import type { RegisteredRepo } from '@/utils/workspaceRepos';
import { ActionMenuModal } from './ActionMenuModal';
import type { ActionMenuItem } from './ActionMenu';
import { useShallow } from 'zustand/react/shallow';

// --- Public types ---

export interface SelectedRepo {
    repo: RegisteredRepo | { path: string; displayName: string };
    targetBranch?: string;
}

interface RepoPickerBarProps {
    machineId: string;
    selectedRepos: SelectedRepo[];
    onReposChange: (repos: SelectedRepo[]) => void;
    /** Called when user taps "Add directory...". Parent should prompt for a path and add the repo. */
    onAddDirectory: () => void;
}

// --- Helpers ---

/** Stable identity key for a repo (registered repos have `id`, ad-hoc ones use `path`). */
const repoKey = (repo: SelectedRepo['repo']): string =>
    'id' in repo && repo.id ? repo.id : repo.path;

/** Get the base path for a repo (registered uses `.path`, ad-hoc uses `.path` directly). */
const repoBasePath = (repo: SelectedRepo['repo']): string => repo.path;

// --- Component ---

/**
 * RepoPickerBar – lets users select repositories for a multi-repo workspace.
 *
 * Shows registered repos for the given machine sorted by most-recently-used,
 * highlights the ones that are already selected, and provides an
 * "Add directory..." action so the parent can trigger a directory browser.
 *
 * Tapping an unselected chip selects it (using defaultTargetBranch if configured).
 * Tapping a selected chip opens a branch picker (ActionMenuModal with local + remote branches).
 * Tapping × on a selected chip removes it.
 */
export const RepoPickerBar: React.FC<RepoPickerBarProps> = React.memo(
    ({ machineId, selectedRepos, onReposChange, onAddDirectory }) => {
        const [fetchingBranches, setFetchingBranches] = useState<string | null>(null);
        const [branchMenuVisible, setBranchMenuVisible] = useState(false);
        const [branchMenuItems, setBranchMenuItems] = useState<ActionMenuItem[]>([]);

        // Registered repos for the machine (reactive), sorted by lastUsedAt (most recent first)
        const rawRepos = storage(useShallow((state) => state.registeredRepos[machineId] || [])) as RegisteredRepo[];
        const registeredRepos = useMemo(
            () => [...rawRepos].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
            [rawRepos],
        );

        // Set of selected keys for O(1) lookup
        const selectedKeys = useMemo(
            () => new Set(selectedRepos.map((s) => repoKey(s.repo))),
            [selectedRepos],
        );

        // Find target branch for a selected repo by key
        const getTargetBranch = useCallback(
            (key: string): string | undefined => {
                return selectedRepos.find((s) => repoKey(s.repo) === key)?.targetBranch;
            },
            [selectedRepos],
        );

        const selectRepo = useCallback(
            (repo: RegisteredRepo) => {
                const defaultBranch = repo.defaultTargetBranch;
                onReposChange([...selectedRepos, { repo, targetBranch: defaultBranch }]);
            },
            [selectedRepos, onReposChange],
        );

        const removeRepo = useCallback(
            (key: string) => {
                onReposChange(selectedRepos.filter((s) => repoKey(s.repo) !== key));
            },
            [selectedRepos, onReposChange],
        );

        const updateTargetBranch = useCallback(
            (key: string, branch: string) => {
                onReposChange(
                    selectedRepos.map((s) =>
                        repoKey(s.repo) === key ? { ...s, targetBranch: branch } : s,
                    ),
                );
            },
            [selectedRepos, onReposChange],
        );

        const showBranchPicker = useCallback(
            async (repo: SelectedRepo['repo']) => {
                const key = repoKey(repo);
                const basePath = repoBasePath(repo);
                if (!basePath) return;

                setFetchingBranches(key);
                try {
                    // Fetch local and remote branches in parallel
                    const [localResult, remoteResult] = await Promise.all([
                        machineBash(machineId, "git branch --list --format='%(refname:short)'", basePath),
                        machineBash(machineId, "git branch -r --format='%(refname:short)'", basePath),
                    ]);

                    const localBranches = localResult.success && localResult.stdout.trim()
                        ? localResult.stdout.trim().split('\n').filter(Boolean)
                        : [];
                    const remoteBranches = remoteResult.success && remoteResult.stdout.trim()
                        ? remoteResult.stdout.trim().split('\n').filter(b => b && b.includes('/') && !b.endsWith('/HEAD'))
                        : [];

                    if (localBranches.length === 0 && remoteBranches.length === 0) {
                        Modal.alert(t('common.error'), 'No branches found');
                        return;
                    }

                    const currentBranch = getTargetBranch(key);
                    const localSet = new Set(localBranches);

                    // Build menu items: local branches first, then remote-only
                    const items: ActionMenuItem[] = localBranches.map(branch => ({
                        label: branch,
                        selected: branch === currentBranch,
                        onPress: () => {
                            updateTargetBranch(key, branch);
                            setBranchMenuVisible(false);
                        },
                    }));

                    for (const remote of remoteBranches) {
                        const shortName = remote.includes('/') ? remote.substring(remote.indexOf('/') + 1) : remote;
                        if (!localSet.has(shortName)) {
                            items.push({
                                label: remote,
                                selected: remote === currentBranch,
                                onPress: () => {
                                    updateTargetBranch(key, remote);
                                    setBranchMenuVisible(false);
                                },
                                secondary: true,
                            });
                        }
                    }

                    setBranchMenuItems(items);
                    setBranchMenuVisible(true);
                } finally {
                    setFetchingBranches(null);
                }
            },
            [machineId, getTargetBranch, updateTargetBranch],
        );

        const handleChipPress = useCallback(
            (repo: RegisteredRepo) => {
                const key = repoKey(repo);
                if (selectedKeys.has(key)) {
                    // Already selected → open branch picker
                    showBranchPicker(repo);
                } else {
                    // Not selected → select it
                    selectRepo(repo);
                }
            },
            [selectedKeys, selectRepo, showBranchPicker],
        );

        const handleAdHocChipPress = useCallback(
            (selected: SelectedRepo) => {
                showBranchPicker(selected.repo);
            },
            [showBranchPicker],
        );

        return (
            <>
                <View style={stylesheet.container}>
                    {/* Registered repo chips */}
                    {registeredRepos.map((repo) => {
                        const key = repoKey(repo);
                        const isSelected = selectedKeys.has(key);
                        const targetBranch = isSelected ? getTargetBranch(key) : undefined;
                        const isFetching = fetchingBranches === key;
                        return (
                            <Pressable
                                key={key}
                                onPress={() => handleChipPress(repo)}
                                disabled={isFetching}
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
                                    {targetBranch ? ` · ${targetBranch}` : ''}
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
                        .filter((s) => s.repo.path !== '')
                        .map((s) => {
                            const key = repoKey(s.repo);
                            const isFetching = fetchingBranches === key;
                            return (
                                <Pressable
                                    key={key}
                                    onPress={() => handleAdHocChipPress(s)}
                                    disabled={isFetching}
                                    style={[stylesheet.chip, stylesheet.chipSelected]}
                                >
                                    <Text style={[stylesheet.chipText, stylesheet.chipTextSelected]} numberOfLines={1}>
                                        {s.repo.displayName || s.repo.path}
                                        {s.targetBranch ? ` · ${s.targetBranch}` : ''}
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
                                </Pressable>
                            );
                        })}

                    {/* Add directory action */}
                    <Pressable onPress={onAddDirectory} style={stylesheet.addChip}>
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

                {/* Branch picker modal */}
                <ActionMenuModal
                    visible={branchMenuVisible}
                    title={t('newSession.repos.targetBranch')}
                    items={branchMenuItems}
                    onClose={() => setBranchMenuVisible(false)}
                />
            </>
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
        justifyContent: 'center',
        paddingHorizontal: 12,
        height: 32,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.surfaceHigh,
    },
    chipSelected: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
    },
    chipText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        maxWidth: 200,
    },
    chipTextSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    removeButton: {
        marginLeft: 6,
        padding: 1,
    },
    removeIcon: {
        // Style-as-data: the color is read imperatively by the component.
        color: theme.colors.deleteAction,
    },
    addChip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        height: 32,
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
