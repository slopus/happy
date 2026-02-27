import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, Switch } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { storage } from '@/sync/storage';
import { saveRegisteredRepos } from '@/sync/repoStore';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import type { RegisteredRepo } from '@/utils/workspaceRepos';
import { machineBash } from '@/sync/ops';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { FolderPickerSheet } from '@/components/FolderPickerSheet';
import { storeTempData } from '@/utils/tempDataStore';

/**
 * Repo edit settings page.
 * Lets users edit a RegisteredRepo's configuration: display name, scripts, working directory, etc.
 * Uses Modal.prompt for text field editing and saves changes to both Zustand and server KV store.
 */
export default React.memo(function RepoEditScreen() {
    const { theme } = useUnistyles();
    const { id: machineId, repoId } = useLocalSearchParams<{ id: string; repoId: string }>();
    const router = useRouter();

    // Load the repo from Zustand store
    const repos = storage.getState().registeredRepos[machineId!] || [];
    const initialRepo = useMemo(() => repos.find(r => r.id === repoId), [repoId]);

    // Local state for all editable fields
    const [displayName, setDisplayName] = useState(initialRepo?.displayName ?? '');
    const [defaultTargetBranch, setDefaultTargetBranch] = useState(initialRepo?.defaultTargetBranch ?? '');
    const [defaultWorkingDir, setDefaultWorkingDir] = useState(initialRepo?.defaultWorkingDir ?? '');
    const [setupScript, setSetupScript] = useState(initialRepo?.setupScript ?? '');
    const [parallelSetup, setParallelSetup] = useState(initialRepo?.parallelSetup ?? false);
    const [cleanupScript, setCleanupScript] = useState(initialRepo?.cleanupScript ?? '');
    const [archiveScript, setArchiveScript] = useState(initialRepo?.archiveScript ?? '');
    const [devServerScript, setDevServerScript] = useState(initialRepo?.devServerScript ?? '');
    const [copyFiles, setCopyFiles] = useState(initialRepo?.copyFiles ?? '');
    const [branchMenuVisible, setBranchMenuVisible] = useState(false);
    const [branchMenuItems, setBranchMenuItems] = useState<ActionMenuItem[]>([]);
    const [fetchingBranches, setFetchingBranches] = useState(false);
    const folderPickerRef = useRef<BottomSheetModal>(null);
    const filePickerRef = useRef<BottomSheetModal>(null);

    // Machine homeDir for folder/file picker
    const homeDir = useMemo(() => storage.getState().machines[machineId!]?.metadata?.homeDir, [machineId]);

    // Convert comma-separated relative copyFiles paths to absolute paths for initial selection
    const copyFilesAbsolute = useMemo(() => {
        if (!copyFiles || !initialRepo?.path) return [];
        return copyFiles.split(',').map(s => s.trim()).filter(Boolean).map(f =>
            f.startsWith('/') ? f : initialRepo.path + '/' + f
        );
    }, [copyFiles, initialRepo?.path]);

    // Display text for copy files: show names if <=2, otherwise count
    const copyFilesDisplay = useMemo(() => {
        if (!copyFiles) return undefined;
        const files = copyFiles.split(',').map(s => s.trim()).filter(Boolean);
        if (files.length === 0) return undefined;
        if (files.length <= 2) return files.join(', ');
        return t('repoEdit.copyFilesCount', { count: files.length });
    }, [copyFiles]);

    // Header title with subtitle
    const repoBasename = useMemo(() => {
        const name = displayName || initialRepo?.path?.split('/').pop() || '';
        return name;
    }, [displayName, initialRepo?.path]);

    const headerTitle = useCallback(() => (
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
            <Text numberOfLines={1} style={[repoStyles.headerTitle, { color: theme.colors.header.tint }]}>
                {t('repoEdit.title')}
            </Text>
            <Text numberOfLines={1} style={[repoStyles.headerSubtitle, { color: theme.colors.textSecondary }]}>
                {repoBasename}
            </Text>
        </View>
    ), [theme, repoBasename]);

    // Copy repo path to clipboard
    const handleCopyPath = useCallback(async () => {
        if (!initialRepo?.path) return;
        try {
            await Clipboard.setStringAsync(initialRepo.path);
            hapticsLight(); showCopiedToast();
        } catch {}
    }, [initialRepo?.path]);

    // Persist updated repo to Zustand + server KV store
    const persistRepo = useCallback(async (updatedFields: Partial<RegisteredRepo>) => {
        if (!machineId || !repoId) return;

        const credentials = sync.getCredentials();
        if (!credentials) return;

        const state = storage.getState();
        const currentRepos = state.registeredRepos[machineId] || [];
        const version = state.registeredReposVersions[machineId] ?? -1;

        const updatedRepos = currentRepos.map(r =>
            r.id === repoId ? { ...r, ...updatedFields } : r
        );

        const newVersion = await saveRegisteredRepos(credentials, machineId, updatedRepos, version);
        storage.getState().setRegisteredRepos(machineId, updatedRepos, newVersion);
    }, [machineId, repoId]);

    // Handle folder selection for working directory
    const handleWorkingDirSelected = useCallback(async (selectedPath: string) => {
        if (!initialRepo?.path) return;
        let relative = '';
        if (selectedPath.startsWith(initialRepo.path)) {
            relative = selectedPath.slice(initialRepo.path.length).replace(/^\//, '');
        }
        setDefaultWorkingDir(relative);
        await persistRepo({ defaultWorkingDir: relative || undefined });
    }, [initialRepo?.path, persistRepo]);

    // Handle multi-file selection for copy files (replace with current selection)
    const handleFilesSelected = useCallback(async (filePaths: string[]) => {
        if (!initialRepo?.path) return;
        const relatives = filePaths.map(filePath => {
            if (filePath.startsWith(initialRepo.path)) {
                return filePath.slice(initialRepo.path.length).replace(/^\//, '');
            }
            return filePath;
        }).filter(Boolean);
        const newValue = relatives.join(',');
        setCopyFiles(newValue);
        await persistRepo({ copyFiles: newValue || undefined });
    }, [initialRepo?.path, persistRepo]);

    // Clear all copy files with confirmation
    const handleClearCopyFiles = useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('repoEdit.clearCopyFiles'),
            t('repoEdit.clearCopyFilesConfirm'),
            { destructive: true },
        );
        if (!confirmed) return;
        setCopyFiles('');
        await persistRepo({ copyFiles: undefined });
    }, [persistRepo]);

    // Helper: prompt user for a text value, then update state + persist
    const editTextField = useCallback(async (
        title: string,
        currentValue: string,
        setter: (v: string) => void,
        fieldKey: keyof RegisteredRepo,
        placeholder?: string,
    ) => {
        const newValue = await Modal.prompt(
            title,
            undefined,
            {
                defaultValue: currentValue,
                placeholder: placeholder ?? '',
            },
        );
        if (newValue === null) return; // cancelled
        setter(newValue);
        await persistRepo({ [fieldKey]: newValue || undefined });
    }, [persistRepo]);

    // Open full-page Monaco script editor for a script field
    const openScriptEditor = useCallback((
        title: string,
        currentValue: string,
        field: keyof RegisteredRepo,
    ) => {
        const dataId = storeTempData({
            machineId,
            repoId,
            field,
            title,
            value: currentValue,
        });
        router.push({ pathname: '/machine/[id]/repo/script-editor', params: { id: machineId!, dataId } });
    }, [machineId, repoId, router]);

    // Re-sync local state from Zustand store when returning from script editor
    useFocusEffect(
        useCallback(() => {
            const repos = storage.getState().registeredRepos[machineId!] || [];
            const repo = repos.find(r => r.id === repoId);
            if (repo) {
                setSetupScript(repo.setupScript ?? '');
                setCleanupScript(repo.cleanupScript ?? '');
                setArchiveScript(repo.archiveScript ?? '');
                setDevServerScript(repo.devServerScript ?? '');
                setCopyFiles(repo.copyFiles ?? '');
            }
        }, [machineId, repoId])
    );

    // Edit default target branch via ActionMenuModal with local + remote branches
    const editDefaultTargetBranch = useCallback(async () => {
        if (!machineId || !initialRepo?.path) return;
        setFetchingBranches(true);
        try {
            const [localResult, remoteResult] = await Promise.all([
                machineBash(machineId, "git branch --list --format='%(refname:short)'", initialRepo.path),
                machineBash(machineId, "git branch -r --format='%(refname:short)'", initialRepo.path),
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

            const localSet = new Set(localBranches);
            const items: ActionMenuItem[] = localBranches.map(branch => ({
                label: branch,
                selected: branch === defaultTargetBranch,
                onPress: () => {
                    setDefaultTargetBranch(branch);
                    persistRepo({ defaultTargetBranch: branch });
                    setBranchMenuVisible(false);
                },
            }));
            for (const remote of remoteBranches) {
                const shortName = remote.includes('/') ? remote.substring(remote.indexOf('/') + 1) : remote;
                if (!localSet.has(shortName)) {
                    items.push({
                        label: remote,
                        selected: remote === defaultTargetBranch,
                        onPress: () => {
                            setDefaultTargetBranch(remote);
                            persistRepo({ defaultTargetBranch: remote });
                            setBranchMenuVisible(false);
                        },
                        secondary: true,
                    });
                }
            }
            setBranchMenuItems(items);
            setBranchMenuVisible(true);
        } finally {
            setFetchingBranches(false);
        }
    }, [machineId, initialRepo?.path, defaultTargetBranch, persistRepo]);

    // Toggle parallelSetup switch
    const handleToggleParallelSetup = useCallback(async (value: boolean) => {
        setParallelSetup(value);
        await persistRepo({ parallelSetup: value });
    }, [persistRepo]);

    // Remove repository
    const [removingRepo, handleRemoveRepo] = useHappyAction(useCallback(async () => {
        if (!machineId || !repoId) return;

        const confirmed = await Modal.confirm(
            t('repoEdit.removeRepo'),
            t('repoEdit.removeRepoConfirm'),
            { destructive: true },
        );
        if (!confirmed) return;

        const credentials = sync.getCredentials();
        if (!credentials) return;

        const state = storage.getState();
        const currentRepos = state.registeredRepos[machineId] || [];
        const version = state.registeredReposVersions[machineId] ?? -1;

        const updatedRepos = currentRepos.filter(r => r.id !== repoId);
        const newVersion = await saveRegisteredRepos(credentials, machineId, updatedRepos, version);
        storage.getState().setRegisteredRepos(machineId, updatedRepos, newVersion);

        router.back();
    }, [machineId, repoId, router]));

    if (!initialRepo) {
        return null;
    }

    return (
        <>
            <Stack.Screen options={{ headerTitle }} />
            <ItemList>
                {/* General section */}
                <ItemGroup title={t('repoEdit.general')}>
                    <Item
                        title={t('repoEdit.displayName')}
                        detail={displayName || undefined}
                        onPress={() => editTextField(
                            t('repoEdit.displayName'),
                            displayName,
                            setDisplayName,
                            'displayName',
                        )}
                    />
                    <Item
                        title={t('repoEdit.repoPath')}
                        detail={initialRepo.path}
                        onPress={handleCopyPath}
                    />
                    <Item
                        title={t('repoEdit.defaultTargetBranch')}
                        detail={defaultTargetBranch || undefined}
                        loading={fetchingBranches}
                        onPress={editDefaultTargetBranch}
                    />
                </ItemGroup>

                {/* Working Directory section */}
                <ItemGroup
                    title={t('repoEdit.workingDirectory')}
                    footer={t('repoEdit.defaultWorkingDirFooter')}
                >
                    <Item
                        title={t('repoEdit.defaultWorkingDir')}
                        detail={defaultWorkingDir || undefined}
                        onPress={() => folderPickerRef.current?.present()}
                    />
                </ItemGroup>

                {/* Scripts section */}
                <ItemGroup
                    title={t('repoEdit.scripts')}
                    footer={t('repoEdit.setupScriptFooter')}
                >
                    <Item
                        title={t('repoEdit.setupScript')}
                        detail={setupScript || undefined}
                        onPress={() => openScriptEditor(
                            t('repoEdit.setupScript'),
                            setupScript,
                            'setupScript',
                        )}
                    />
                    <Item
                        title={t('repoEdit.parallelSetup')}
                        showChevron={false}
                        rightElement={
                            <Switch
                                value={parallelSetup}
                                onValueChange={handleToggleParallelSetup}
                                trackColor={{ true: theme.colors.button.primary.background }}
                            />
                        }
                    />
                </ItemGroup>

                <ItemGroup footer={t('repoEdit.cleanupScriptFooter')}>
                    <Item
                        title={t('repoEdit.cleanupScript')}
                        detail={cleanupScript || undefined}
                        onPress={() => openScriptEditor(
                            t('repoEdit.cleanupScript'),
                            cleanupScript,
                            'cleanupScript',
                        )}
                    />
                </ItemGroup>

                <ItemGroup footer={t('repoEdit.archiveScriptFooter')}>
                    <Item
                        title={t('repoEdit.archiveScript')}
                        detail={archiveScript || undefined}
                        onPress={() => openScriptEditor(
                            t('repoEdit.archiveScript'),
                            archiveScript,
                            'archiveScript',
                        )}
                    />
                </ItemGroup>

                <ItemGroup footer={t('repoEdit.devServerScriptFooter')}>
                    <Item
                        title={t('repoEdit.devServerScript')}
                        detail={devServerScript || undefined}
                        onPress={() => openScriptEditor(
                            t('repoEdit.devServerScript'),
                            devServerScript,
                            'devServerScript',
                        )}
                    />
                </ItemGroup>

                {/* Files section */}
                <ItemGroup
                    title={t('repoEdit.files')}
                    footer={t('repoEdit.copyFilesFooter')}
                >
                    <Item
                        title={t('repoEdit.copyFiles')}
                        detail={copyFilesDisplay}
                        onPress={() => filePickerRef.current?.present()}
                    />
                    {copyFiles ? (
                        <Item
                            title={t('repoEdit.clearCopyFiles')}
                            destructive={true}
                            showChevron={false}
                            onPress={handleClearCopyFiles}
                        />
                    ) : null}
                </ItemGroup>

                {/* Danger zone */}
                <ItemGroup>
                    <Item
                        title={t('repoEdit.removeRepo')}
                        destructive={true}
                        showChevron={false}
                        loading={removingRepo}
                        onPress={handleRemoveRepo}
                    />
                </ItemGroup>
            </ItemList>

            {/* Branch picker modal */}
            <ActionMenuModal
                visible={branchMenuVisible}
                title={t('repoEdit.defaultTargetBranch')}
                items={branchMenuItems}
                onClose={() => setBranchMenuVisible(false)}
            />

            {/* Folder picker for working directory */}
            <FolderPickerSheet
                ref={folderPickerRef}
                machineId={machineId!}
                homeDir={initialRepo.path}
                onSelect={handleWorkingDirSelected}
            />

            {/* File picker for copy files (multi-select) */}
            <FolderPickerSheet
                ref={filePickerRef}
                machineId={machineId!}
                homeDir={initialRepo.path}
                mode="file"
                onSelect={() => {}}
                onFileSelect={handleFilesSelected}
                initialSelection={copyFilesAbsolute}
            />
        </>
    );
});

const repoStyles = StyleSheet.create((_theme) => ({
    headerTitle: { ...Typography.default('semiBold'), fontSize: 17 },
    headerSubtitle: { ...Typography.default(), fontSize: 12, lineHeight: 16, marginTop: -2 },
}));
