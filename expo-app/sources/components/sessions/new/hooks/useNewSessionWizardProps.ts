import * as React from 'react';

import type { AgentId } from '@/agents/catalog';
import { t } from '@/text';
import { getRequiredSecretEnvVarNames } from '@/sync/profileSecrets';
import type { AIBackendProfile, SavedSecret } from '@/sync/settings';
import type { Machine } from '@/sync/storageTypes';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import type { CLIAvailability } from '@/hooks/useCLIDetection';
import type { UseMachineEnvPresenceResult } from '@/hooks/useMachineEnvPresence';
import { prefetchMachineCapabilities } from '@/hooks/useMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import type { InstallableDepInstallerProps } from '@/components/machines/InstallableDepInstaller';
import type {
    NewSessionWizardAgentProps,
    NewSessionWizardFooterProps,
    NewSessionWizardLayoutProps,
    NewSessionWizardMachineProps,
    NewSessionWizardProfilesProps,
} from '../components/NewSessionWizard';
import type { CliNotDetectedBannerDismissScope } from '../components/CliNotDetectedBanner';

function tNoParams(key: string): string {
    return (t as any)(key);
}

export function useNewSessionWizardProps(params: Readonly<{
    // Layout
    theme: any;
    styles: any;
    safeAreaBottom: number;
    headerHeight: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;

    // Profiles section
    useProfiles: boolean;
    profiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    setFavoriteProfileIds: (ids: string[]) => void;
    experimentsEnabled: boolean;
    selectedProfileId: string | null;
    onPressDefaultEnvironment: () => void;
    onPressProfile: (profile: AIBackendProfile) => void;
    selectedMachineId: string | null;
    getProfileDisabled: (profile: AIBackendProfile) => boolean;
    getProfileSubtitleExtra: (profile: AIBackendProfile) => string | null;
    handleAddProfile: () => void;
    openProfileEdit: (params: { profileId: string }) => void;
    handleDuplicateProfile: (profile: AIBackendProfile) => void;
    handleDeleteProfile: (profile: AIBackendProfile) => void;
    openProfileEnvVarsPreview: (profile: AIBackendProfile) => void;
    suppressNextSecretAutoPromptKeyRef: React.MutableRefObject<string | null>;
    openSecretRequirementModal: (profile: AIBackendProfile, opts: { revertOnCancel: boolean }) => void;
    profilesGroupTitles: { favorites: string; custom: string; builtIn: string };

    // Secret satisfaction helpers
    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;

    // Installable deps
    wizardInstallableDeps: Array<{ entry: any; depStatus: any }>;
    selectedMachineCapabilities: { status: any };

    // Agent section
    cliAvailability: CLIAvailability;
    tmuxRequested: boolean;
    enabledAgentIds: AgentId[];
    isCliBannerDismissed: (agentId: AgentId) => boolean;
    dismissCliBanner: (agentId: AgentId, scope: CliNotDetectedBannerDismissScope) => void;
    agentType: AgentId;
    setAgentType: (agent: AgentId) => void;
    modelOptions: ReadonlyArray<{ value: ModelMode; label: string; description: string }>;
    modelMode: ModelMode | undefined;
    setModelMode: (mode: ModelMode) => void;
    selectedIndicatorColor: string;
    profileMap: Map<string, AIBackendProfile>;
    permissionMode: PermissionMode;
    handlePermissionModeChange: (mode: PermissionMode) => void;
    sessionType: 'simple' | 'worktree';
    setSessionType: (t: 'simple' | 'worktree') => void;

    // Machine section
    machines: Machine[];
    selectedMachine: Machine | null;
    recentMachines: Machine[];
    favoriteMachineItems: Machine[];
    useMachinePickerSearch: boolean;
    refreshMachineData: () => void;
    setSelectedMachineId: (id: string) => void;
    getBestPathForMachine: (id: string | null) => string;
    setSelectedPath: (path: string) => void;
    favoriteMachines: string[];
    setFavoriteMachines: (ids: string[]) => void;
    selectedPath: string;
    recentPaths: string[];
    usePathPickerSearch: boolean;
    favoriteDirectories: string[];
    setFavoriteDirectories: (dirs: string[]) => void;

    // Footer section
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: () => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompletePrefixes: any;
    emptyAutocompleteSuggestions: any;
    connectionStatus?: any;
    selectedProfileEnvVarsCount: number;
    handleEnvVarsClick: () => void;
    resumeSessionId: string;
    showResumePicker: boolean;
    handleResumeClick: () => void;
    isResumeSupportChecking: boolean;
    sessionPromptInputMaxHeight: number;
    agentInputExtraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
}>): Readonly<{
    layout: NewSessionWizardLayoutProps;
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}> {
    const wizardLayoutProps = React.useMemo((): NewSessionWizardLayoutProps => {
        return {
            theme: params.theme,
            styles: params.styles,
            safeAreaBottom: params.safeAreaBottom,
            headerHeight: params.headerHeight,
            newSessionSidePadding: params.newSessionSidePadding,
            newSessionBottomPadding: params.newSessionBottomPadding,
        };
    }, [
        params.headerHeight,
        params.newSessionBottomPadding,
        params.newSessionSidePadding,
        params.safeAreaBottom,
        params.theme,
        params.styles,
    ]);

    const getSecretSatisfactionForProfile = React.useCallback((profile: AIBackendProfile) => {
        const selectedSecretIds = params.selectedSecretIdByProfileIdByEnvVarName[profile.id] ?? null;
        const sessionOnlyValues = params.sessionOnlySecretValueByProfileIdByEnvVarName[profile.id] ?? null;
        const machineEnvReadyByName = Object.fromEntries(
            Object.entries(params.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
        );
        return getSecretSatisfaction({
            profile,
            secrets: params.secrets,
            defaultBindings: params.secretBindingsByProfileId[profile.id] ?? null,
            selectedSecretIds,
            sessionOnlyValues,
            machineEnvReadyByName,
        });
    }, [
        params.machineEnvPresence.meta,
        params.secrets,
        params.secretBindingsByProfileId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
    ]);

    const getSecretOverrideReady = React.useCallback((profile: AIBackendProfile): boolean => {
        const satisfaction = getSecretSatisfactionForProfile(profile);
        // Override should only represent non-machine satisfaction (defaults / saved / session-only).
        if (!satisfaction.hasSecretRequirements) return false;
        const required = satisfaction.items.filter((i) => i.required);
        if (required.length === 0) return false;
        if (!required.every((i) => i.isSatisfied)) return false;
        return required.some((i) => i.satisfiedBy !== 'machineEnv');
    }, [getSecretSatisfactionForProfile]);

    const getSecretMachineEnvOverride = React.useCallback((profile: AIBackendProfile) => {
        if (!params.selectedMachineId) return null;
        if (!params.machineEnvPresence.isPreviewEnvSupported) return null;
        const requiredNames = getRequiredSecretEnvVarNames(profile);
        if (requiredNames.length === 0) return null;
        return {
            isReady: requiredNames.every((name) => Boolean(params.machineEnvPresence.meta[name]?.isSet)),
            isLoading: params.machineEnvPresence.isLoading,
        };
    }, [
        params.machineEnvPresence.isLoading,
        params.machineEnvPresence.isPreviewEnvSupported,
        params.machineEnvPresence.meta,
        params.selectedMachineId,
    ]);

    const wizardProfilesProps = React.useMemo((): NewSessionWizardProfilesProps => {
        return {
            useProfiles: params.useProfiles,
            profiles: params.profiles,
            favoriteProfileIds: params.favoriteProfileIds,
            setFavoriteProfileIds: params.setFavoriteProfileIds,
            experimentsEnabled: params.experimentsEnabled,
            selectedProfileId: params.selectedProfileId,
            onPressDefaultEnvironment: params.onPressDefaultEnvironment,
            onPressProfile: params.onPressProfile,
            selectedMachineId: params.selectedMachineId,
            getProfileDisabled: params.getProfileDisabled,
            getProfileSubtitleExtra: params.getProfileSubtitleExtra,
            handleAddProfile: params.handleAddProfile,
            openProfileEdit: params.openProfileEdit,
            handleDuplicateProfile: params.handleDuplicateProfile,
            handleDeleteProfile: params.handleDeleteProfile,
            openProfileEnvVarsPreview: params.openProfileEnvVarsPreview,
            suppressNextSecretAutoPromptKeyRef: params.suppressNextSecretAutoPromptKeyRef,
            openSecretRequirementModal: params.openSecretRequirementModal,
            profilesGroupTitles: params.profilesGroupTitles,
            getSecretOverrideReady,
            getSecretSatisfactionForProfile,
            getSecretMachineEnvOverride,
        };
    }, [
        params.experimentsEnabled,
        params.favoriteProfileIds,
        params.getProfileDisabled,
        params.getProfileSubtitleExtra,
        params.handleAddProfile,
        params.handleDeleteProfile,
        params.handleDuplicateProfile,
        params.onPressDefaultEnvironment,
        params.onPressProfile,
        params.openProfileEdit,
        params.openProfileEnvVarsPreview,
        params.openSecretRequirementModal,
        params.profiles,
        params.profilesGroupTitles,
        params.selectedMachineId,
        params.selectedProfileId,
        params.setFavoriteProfileIds,
        params.suppressNextSecretAutoPromptKeyRef,
        params.useProfiles,
        getSecretOverrideReady,
        getSecretSatisfactionForProfile,
        getSecretMachineEnvOverride,
    ]);

    const installableDepInstallers = React.useMemo((): InstallableDepInstallerProps[] => {
        if (!params.selectedMachineId) return [];
        if (params.wizardInstallableDeps.length === 0) return [];

        return params.wizardInstallableDeps.map(({ entry, depStatus }) => ({
            machineId: params.selectedMachineId!,
            enabled: true,
            groupTitle: `${tNoParams(entry.groupTitleKey)}${entry.experimental ? ' (experimental)' : ''}`,
            depId: entry.depId,
            depTitle: entry.depTitle,
            depIconName: entry.depIconName as any,
            depStatus,
            capabilitiesStatus: params.selectedMachineCapabilities.status,
            installSpecSettingKey: entry.installSpecSettingKey,
            installSpecTitle: entry.installSpecTitle,
            installSpecDescription: entry.installSpecDescription,
            installLabels: {
                install: tNoParams(entry.installLabels.installKey),
                update: tNoParams(entry.installLabels.updateKey),
                reinstall: tNoParams(entry.installLabels.reinstallKey),
            },
            installModal: {
                installTitle: tNoParams(entry.installModal.installTitleKey),
                updateTitle: tNoParams(entry.installModal.updateTitleKey),
                reinstallTitle: tNoParams(entry.installModal.reinstallTitleKey),
                description: tNoParams(entry.installModal.descriptionKey),
            },
            refreshStatus: () => {
                void prefetchMachineCapabilities({ machineId: params.selectedMachineId!, request: CAPABILITIES_REQUEST_NEW_SESSION });
            },
            refreshRegistry: () => {
                void prefetchMachineCapabilities({ machineId: params.selectedMachineId!, request: entry.buildRegistryDetectRequest(), timeoutMs: 12_000 });
            },
        }));
    }, [params.selectedMachineCapabilities.status, params.selectedMachineId, params.wizardInstallableDeps]);

    const wizardAgentProps = React.useMemo((): NewSessionWizardAgentProps => {
        return {
            cliAvailability: params.cliAvailability,
            tmuxRequested: params.tmuxRequested,
            enabledAgentIds: params.enabledAgentIds,
            isCliBannerDismissed: params.isCliBannerDismissed,
            dismissCliBanner: params.dismissCliBanner,
            agentType: params.agentType,
            setAgentType: params.setAgentType,
            modelOptions: params.modelOptions,
            modelMode: params.modelMode,
            setModelMode: params.setModelMode,
            selectedIndicatorColor: params.selectedIndicatorColor,
            profileMap: params.profileMap,
            permissionMode: params.permissionMode,
            handlePermissionModeChange: params.handlePermissionModeChange,
            sessionType: params.sessionType,
            setSessionType: params.setSessionType,
            installableDepInstallers,
        };
    }, [
        params.agentType,
        params.cliAvailability,
        params.dismissCliBanner,
        params.enabledAgentIds,
        params.isCliBannerDismissed,
        params.modelMode,
        params.modelOptions,
        params.permissionMode,
        params.profileMap,
        params.selectedIndicatorColor,
        params.sessionType,
        params.setAgentType,
        params.setModelMode,
        params.setSessionType,
        params.handlePermissionModeChange,
        params.tmuxRequested,
        installableDepInstallers,
    ]);

    const wizardMachineProps = React.useMemo((): NewSessionWizardMachineProps => {
        return {
            machines: params.machines,
            selectedMachine: params.selectedMachine || null,
            recentMachines: params.recentMachines,
            favoriteMachineItems: params.favoriteMachineItems,
            useMachinePickerSearch: params.useMachinePickerSearch,
            onRefreshMachines: params.refreshMachineData,
            setSelectedMachineId: params.setSelectedMachineId as any,
            getBestPathForMachine: params.getBestPathForMachine as any,
            setSelectedPath: params.setSelectedPath,
            favoriteMachines: params.favoriteMachines,
            setFavoriteMachines: params.setFavoriteMachines,
            selectedPath: params.selectedPath,
            recentPaths: params.recentPaths,
            usePathPickerSearch: params.usePathPickerSearch,
            favoriteDirectories: params.favoriteDirectories,
            setFavoriteDirectories: params.setFavoriteDirectories,
        };
    }, [
        params.favoriteDirectories,
        params.favoriteMachineItems,
        params.favoriteMachines,
        params.getBestPathForMachine,
        params.machines,
        params.recentMachines,
        params.recentPaths,
        params.refreshMachineData,
        params.selectedMachine,
        params.selectedPath,
        params.setFavoriteDirectories,
        params.setFavoriteMachines,
        params.setSelectedMachineId,
        params.setSelectedPath,
        params.useMachinePickerSearch,
        params.usePathPickerSearch,
    ]);

    const wizardFooterProps = React.useMemo((): NewSessionWizardFooterProps => {
        return {
            sessionPrompt: params.sessionPrompt,
            setSessionPrompt: params.setSessionPrompt,
            handleCreateSession: params.handleCreateSession,
            canCreate: params.canCreate,
            isCreating: params.isCreating,
            emptyAutocompletePrefixes: params.emptyAutocompletePrefixes,
            emptyAutocompleteSuggestions: params.emptyAutocompleteSuggestions,
            connectionStatus: params.connectionStatus,
            selectedProfileEnvVarsCount: params.selectedProfileEnvVarsCount,
            handleEnvVarsClick: params.handleEnvVarsClick,
            resumeSessionId: params.resumeSessionId,
            onResumeClick: params.showResumePicker ? params.handleResumeClick : undefined,
            resumeIsChecking: params.isResumeSupportChecking,
            inputMaxHeight: params.sessionPromptInputMaxHeight,
            agentInputExtraActionChips: params.agentInputExtraActionChips,
        };
        // NOTE: Agent selection doesn't affect these props, but keeping dependencies
        // broad mirrors the previous in-screen memoization behavior and avoids subtle
        // referential changes during refactors.
    }, [
        params.agentType,
        params.agentInputExtraActionChips,
        params.canCreate,
        params.connectionStatus,
        params.experimentsEnabled,
        params.emptyAutocompletePrefixes,
        params.emptyAutocompleteSuggestions,
        params.handleCreateSession,
        params.handleEnvVarsClick,
        params.handleResumeClick,
        params.isCreating,
        params.isResumeSupportChecking,
        params.resumeSessionId,
        params.selectedProfileEnvVarsCount,
        params.sessionPrompt,
        params.sessionPromptInputMaxHeight,
        params.showResumePicker,
        params.setSessionPrompt,
    ]);

    return {
        layout: wizardLayoutProps,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    };
}
