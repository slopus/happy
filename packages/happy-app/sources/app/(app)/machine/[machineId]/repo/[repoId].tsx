import React, { useState, useCallback, useMemo } from 'react';
import { Switch } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { storage } from '@/sync/storage';
import { saveRegisteredRepos } from '@/sync/repoStore';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import type { RegisteredRepo } from '@/utils/workspaceRepos';

/**
 * Repo edit settings page.
 * Lets users edit a RegisteredRepo's configuration: display name, scripts, working directory, etc.
 * Uses Modal.prompt for text field editing and saves changes to both Zustand and server KV store.
 */
export default React.memo(function RepoEditScreen() {
    const { theme } = useUnistyles();
    const { machineId, repoId } = useLocalSearchParams<{ machineId: string; repoId: string }>();
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
            <Stack.Screen options={{ headerTitle: initialRepo.displayName || t('repoEdit.title') }} />
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
                        showChevron={false}
                        copy={initialRepo.path}
                    />
                    <Item
                        title={t('repoEdit.defaultTargetBranch')}
                        detail={defaultTargetBranch || undefined}
                        onPress={() => editTextField(
                            t('repoEdit.defaultTargetBranch'),
                            defaultTargetBranch,
                            setDefaultTargetBranch,
                            'defaultTargetBranch',
                            'main',
                        )}
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
                        onPress={() => editTextField(
                            t('repoEdit.defaultWorkingDir'),
                            defaultWorkingDir,
                            setDefaultWorkingDir,
                            'defaultWorkingDir',
                            'packages/my-app',
                        )}
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
                        onPress={() => editTextField(
                            t('repoEdit.setupScript'),
                            setupScript,
                            setSetupScript,
                            'setupScript',
                            'npm install',
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
                        onPress={() => editTextField(
                            t('repoEdit.cleanupScript'),
                            cleanupScript,
                            setCleanupScript,
                            'cleanupScript',
                        )}
                    />
                </ItemGroup>

                <ItemGroup footer={t('repoEdit.archiveScriptFooter')}>
                    <Item
                        title={t('repoEdit.archiveScript')}
                        detail={archiveScript || undefined}
                        onPress={() => editTextField(
                            t('repoEdit.archiveScript'),
                            archiveScript,
                            setArchiveScript,
                            'archiveScript',
                        )}
                    />
                </ItemGroup>

                <ItemGroup footer={t('repoEdit.devServerScriptFooter')}>
                    <Item
                        title={t('repoEdit.devServerScript')}
                        detail={devServerScript || undefined}
                        onPress={() => editTextField(
                            t('repoEdit.devServerScript'),
                            devServerScript,
                            setDevServerScript,
                            'devServerScript',
                            'npm run dev',
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
                        detail={copyFiles || undefined}
                        onPress={() => editTextField(
                            t('repoEdit.copyFiles'),
                            copyFiles,
                            setCopyFiles,
                            'copyFiles',
                            '.env,.env.local',
                        )}
                    />
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
        </>
    );
});
