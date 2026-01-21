import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { LinearGradient } from 'expo-linear-gradient';
import Color from 'color';
import { Typography } from '@/constants/Typography';
import { AgentInput } from '@/components/AgentInput';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import { PathSelector } from '@/components/newSession/PathSelector';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { SessionTypeSelectorRows } from '@/components/SessionTypeSelector';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getBuiltInProfile } from '@/sync/profileUtils';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/settings';
import { useSetting } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import type { SecretSatisfactionResult } from '@/utils/secretSatisfaction';

type CLIAvailability = {
    claude: boolean | null;
    codex: boolean | null;
    gemini: boolean | null;
    tmux: boolean | null;
    login: { claude: boolean | null; codex: boolean | null; gemini: boolean | null };
    isDetecting: boolean;
    timestamp: number;
    error?: string;
};

export interface NewSessionWizardLayoutProps {
    theme: any;
    styles: any;
    safeAreaBottom: number;
    headerHeight: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
}

export interface NewSessionWizardProfilesProps {
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
    getSecretOverrideReady: (profile: AIBackendProfile) => boolean;
    // NOTE: Multi-secret satisfaction result shape is evolving; wizard only needs `isSatisfied`.
    // Keep this permissive to avoid cross-file type coupling.
    getSecretSatisfactionForProfile: (profile: AIBackendProfile) => { isSatisfied: boolean };
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
}

export interface NewSessionWizardAgentProps {
    cliAvailability: CLIAvailability;
    tmuxRequested: boolean;
    allowGemini: boolean;
    isWarningDismissed: (cli: 'claude' | 'codex' | 'gemini') => boolean;
    hiddenBanners: { claude: boolean; codex: boolean; gemini: boolean };
    handleCLIBannerDismiss: (cli: 'claude' | 'codex' | 'gemini', scope: 'machine' | 'global' | 'temporary') => void;
    agentType: 'claude' | 'codex' | 'gemini';
    setAgentType: (agent: 'claude' | 'codex' | 'gemini') => void;
    modelOptions: ReadonlyArray<{ value: ModelMode; label: string; description: string }>;
    modelMode: ModelMode | undefined;
    setModelMode: (mode: ModelMode) => void;
    selectedIndicatorColor: string;
    profileMap: Map<string, AIBackendProfile>;
    permissionMode: PermissionMode;
    handlePermissionModeChange: (mode: PermissionMode) => void;
    sessionType: 'simple' | 'worktree';
    setSessionType: (t: 'simple' | 'worktree') => void;
}

export interface NewSessionWizardMachineProps {
    machines: Machine[];
    selectedMachine: Machine | null;
    recentMachines: Machine[];
    favoriteMachineItems: Machine[];
    useMachinePickerSearch: boolean;
    onRefreshMachines?: () => void;
    setSelectedMachineId: (id: string) => void;
    getBestPathForMachine: (id: string) => string;
    setSelectedPath: (path: string) => void;
    favoriteMachines: string[];
    setFavoriteMachines: (ids: string[]) => void;
    selectedPath: string;
    recentPaths: string[];
    usePathPickerSearch: boolean;
    favoriteDirectories: string[];
    setFavoriteDirectories: (dirs: string[]) => void;
}

export interface NewSessionWizardFooterProps {
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: () => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    connectionStatus?: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    selectedProfileEnvVarsCount: number;
    handleEnvVarsClick: () => void;
}

export interface NewSessionWizardProps {
    layout: NewSessionWizardLayoutProps;
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}

export const NewSessionWizard = React.memo(function NewSessionWizard(props: NewSessionWizardProps) {
    const {
        theme,
        styles,
        safeAreaBottom,
        headerHeight,
        newSessionSidePadding,
        newSessionBottomPadding,
    } = props.layout;

    // Wizard-only scroll bookkeeping (keep it out of NewSessionScreen)
    const scrollViewRef = React.useRef<ScrollView>(null);
    const wizardSectionOffsets = React.useRef<{
        profile?: number;
        agent?: number;
        model?: number;
        machine?: number;
        path?: number;
        permission?: number;
        sessionType?: number;
    }>({});
    const registerWizardSectionOffset = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        return (e: any) => {
            wizardSectionOffsets.current[key] = e?.nativeEvent?.layout?.y ?? 0;
        };
    }, []);
    const scrollToWizardSection = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        const y = wizardSectionOffsets.current[key];
        if (typeof y !== 'number' || !scrollViewRef.current) return;
        scrollViewRef.current.scrollTo({ y: Math.max(0, y - 20), animated: true });
    }, []);

    const handleAgentInputProfileClick = React.useCallback(() => {
        scrollToWizardSection('profile');
    }, [scrollToWizardSection]);

    const handleAgentInputMachineClick = React.useCallback(() => {
        scrollToWizardSection('machine');
    }, [scrollToWizardSection]);

    const handleAgentInputPathClick = React.useCallback(() => {
        scrollToWizardSection('path');
    }, [scrollToWizardSection]);

    const handleAgentInputPermissionClick = React.useCallback(() => {
        scrollToWizardSection('permission');
    }, [scrollToWizardSection]);

    const handleAgentInputAgentClick = React.useCallback(() => {
        scrollToWizardSection('agent');
    }, [scrollToWizardSection]);

    const onRefreshMachines = props.machine.onRefreshMachines;

    const {
        useProfiles,
        profiles,
        favoriteProfileIds,
        setFavoriteProfileIds,
        experimentsEnabled,
        selectedProfileId,
        onPressDefaultEnvironment,
        onPressProfile,
        selectedMachineId,
        getProfileDisabled,
        getProfileSubtitleExtra,
        handleAddProfile,
        openProfileEdit,
        handleDuplicateProfile,
        handleDeleteProfile,
        openProfileEnvVarsPreview,
        suppressNextSecretAutoPromptKeyRef,
        openSecretRequirementModal,
        profilesGroupTitles,
        getSecretOverrideReady,
        getSecretSatisfactionForProfile,
        getSecretMachineEnvOverride,
    } = props.profiles;

    const expSessionType = useSetting('expSessionType');
    const showSessionTypeSelector = experimentsEnabled && expSessionType;

    const {
        cliAvailability,
        tmuxRequested,
        allowGemini,
        isWarningDismissed,
        hiddenBanners,
        handleCLIBannerDismiss,
        agentType,
        setAgentType,
        modelOptions,
        modelMode,
        setModelMode,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        handlePermissionModeChange,
        sessionType,
        setSessionType,
    } = props.agent;

    const {
        machines,
        selectedMachine,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        setSelectedMachineId,
        getBestPathForMachine,
        setSelectedPath,
        favoriteMachines,
        setFavoriteMachines,
        selectedPath,
        recentPaths,
        usePathPickerSearch,
        favoriteDirectories,
        setFavoriteDirectories,
    } = props.machine;

    const {
        sessionPrompt,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        connectionStatus,
        selectedProfileEnvVarsCount,
        handleEnvVarsClick,
    } = props.footer;

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight + safeAreaBottom + 16 : 0}
            style={[styles.container, { backgroundColor: theme.colors.groupped.background }]}
        >
            <View style={{ flex: 1 }}>
                <ScrollView
                    ref={scrollViewRef}
                    style={styles.scrollContainer}
                    contentContainerStyle={styles.contentContainer}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={{ paddingHorizontal: 0 }}>
                        <View style={[
                            { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                        ]}>
                            <View onLayout={registerWizardSectionOffset('profile')} style={styles.wizardContainer}>
                                {useProfiles && (
                                    <>
                                        <View style={styles.wizardSectionHeaderRow}>
                                            <Ionicons name="person-outline" size={18} color={theme.colors.text} />
                                            <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                                {t('newSession.selectAiProfileTitle')}
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectAiProfileDescription')}
                                        </Text>
                                        <ProfilesList
                                            customProfiles={profiles}
                                            favoriteProfileIds={favoriteProfileIds}
                                            onFavoriteProfileIdsChange={setFavoriteProfileIds}
                                            experimentsEnabled={experimentsEnabled}
                                            selectedProfileId={selectedProfileId}
                                            popoverBoundaryRef={scrollViewRef}
                                            includeDefaultEnvironmentRow
                                            onPressDefaultEnvironment={onPressDefaultEnvironment}
                                            onPressProfile={onPressProfile}
                                            machineId={selectedMachineId ?? null}
                                            getSecretOverrideReady={getSecretOverrideReady}
                                            getSecretMachineEnvOverride={getSecretMachineEnvOverride}
                                            getProfileDisabled={getProfileDisabled}
                                            getProfileSubtitleExtra={getProfileSubtitleExtra}
                                            includeAddProfileRow
                                            onAddProfilePress={handleAddProfile}
                                            onEditProfile={(profile) => openProfileEdit({ profileId: profile.id })}
                                            onDuplicateProfile={handleDuplicateProfile}
                                            onDeleteProfile={handleDeleteProfile}
                                            getHasEnvironmentVariables={(profile) => Object.keys(getProfileEnvironmentVariables(profile)).length > 0}
                                            onViewEnvironmentVariables={openProfileEnvVarsPreview}
                                            onSecretBadgePress={(profile) => {
                                                const satisfaction = getSecretSatisfactionForProfile(profile);
                                                const isMissingForSelectedProfile =
                                                    profile.id === selectedProfileId && !satisfaction.isSatisfied;
                                                openSecretRequirementModal(profile, { revertOnCancel: isMissingForSelectedProfile });
                                            }}
                                            groupTitles={profilesGroupTitles}
                                        />

                                        <View style={{ height: 24 }} />
                                    </>
                                )}

                                {/* Section: AI Backend */}
                                <View onLayout={registerWizardSectionOffset('agent')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        <Ionicons name="hardware-chip-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                            {t('newSession.selectAiBackendTitle')}
                                        </Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {useProfiles && selectedProfileId
                                        ? t('newSession.aiBackendLimitedByProfileAndMachineClis')
                                        : t('newSession.aiBackendSelectWhichAiRuns')}
                                </Text>

                                {/* Missing CLI Installation Banners */}
                                {selectedMachineId && tmuxRequested && cliAvailability.tmux === false && (
                                    <View style={{
                                        backgroundColor: theme.colors.box.warning.background,
                                        borderRadius: 10,
                                        padding: 12,
                                        marginBottom: 12,
                                        borderWidth: 1,
                                        borderColor: theme.colors.box.warning.border,
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                            <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                {t('machine.tmux.notDetectedSubtitle')}
                                            </Text>
                                        </View>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            {t('machine.tmux.notDetectedMessage')}
                                        </Text>
                                    </View>
                                )}

                                {selectedMachineId && cliAvailability.claude === false && !isWarningDismissed('claude') && !hiddenBanners.claude && (
                                    <View style={{
                                        backgroundColor: theme.colors.box.warning.background,
                                        borderRadius: 10,
                                        padding: 12,
                                        marginBottom: 12,
                                        borderWidth: 1,
                                        borderColor: theme.colors.box.warning.border,
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                                <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                    {t('newSession.cliBanners.cliNotDetectedTitle', { cli: t('agentInput.agent.claude') })}
                                                </Text>
                                                <View style={{ flex: 1, minWidth: 20 }} />
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.dontShowFor')}
                                                </Text>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('claude', 'machine')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.thisMachine')}
                                                    </Text>
                                                </Pressable>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('claude', 'global')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.anyMachine')}
                                                    </Text>
                                                </Pressable>
                                            </View>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('claude', 'temporary')}
                                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                            >
                                                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('newSession.cliBanners.installCommand', { command: 'npm install -g @anthropic-ai/claude-code' })}
                                            </Text>
                                            <Pressable onPress={() => {
                                                if (Platform.OS === 'web') {
                                                    window.open('https://docs.anthropic.com/en/docs/claude-code/installation', '_blank');
                                                }
                                            }}>
                                                <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.viewInstallationGuide')}
                                                </Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                )}

                                {selectedMachineId && cliAvailability.codex === false && !isWarningDismissed('codex') && !hiddenBanners.codex && (
                                    <View style={{
                                        backgroundColor: theme.colors.box.warning.background,
                                        borderRadius: 10,
                                        padding: 12,
                                        marginBottom: 12,
                                        borderWidth: 1,
                                        borderColor: theme.colors.box.warning.border,
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                                <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                    {t('newSession.cliBanners.cliNotDetectedTitle', { cli: t('agentInput.agent.codex') })}
                                                </Text>
                                                <View style={{ flex: 1, minWidth: 20 }} />
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.dontShowFor')}
                                                </Text>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('codex', 'machine')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.thisMachine')}
                                                    </Text>
                                                </Pressable>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('codex', 'global')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.anyMachine')}
                                                    </Text>
                                                </Pressable>
                                            </View>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('codex', 'temporary')}
                                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                            >
                                                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('newSession.cliBanners.installCommand', { command: 'npm install -g codex-cli' })}
                                            </Text>
                                            <Pressable onPress={() => {
                                                if (Platform.OS === 'web') {
                                                    window.open('https://github.com/openai/openai-codex', '_blank');
                                                }
                                            }}>
                                                <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.viewInstallationGuide')}
                                                </Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                )}

                                {selectedMachineId && cliAvailability.gemini === false && allowGemini && !isWarningDismissed('gemini') && !hiddenBanners.gemini && (
                                    <View style={{
                                        backgroundColor: theme.colors.box.warning.background,
                                        borderRadius: 10,
                                        padding: 12,
                                        marginBottom: 12,
                                        borderWidth: 1,
                                        borderColor: theme.colors.box.warning.border,
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                                <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                    {t('newSession.cliBanners.cliNotDetectedTitle', { cli: t('agentInput.agent.gemini') })}
                                                </Text>
                                                <View style={{ flex: 1, minWidth: 20 }} />
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.dontShowFor')}
                                                </Text>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('gemini', 'machine')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.thisMachine')}
                                                    </Text>
                                                </Pressable>
                                                <Pressable
                                                    onPress={() => handleCLIBannerDismiss('gemini', 'global')}
                                                    style={{
                                                        borderRadius: 4,
                                                        borderWidth: 1,
                                                        borderColor: theme.colors.textSecondary,
                                                        paddingHorizontal: 8,
                                                        paddingVertical: 3,
                                                    }}
                                                >
                                                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                        {t('newSession.cliBanners.anyMachine')}
                                                    </Text>
                                                </Pressable>
                                            </View>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('gemini', 'temporary')}
                                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                            >
                                                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('newSession.cliBanners.installCliIfAvailable', { cli: t('agentInput.agent.gemini') })}
                                            </Text>
                                            <Pressable onPress={() => {
                                                if (Platform.OS === 'web') {
                                                    window.open('https://ai.google.dev/gemini-api/docs/get-started', '_blank');
                                                }
                                            }}>
                                                <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                    {t('newSession.cliBanners.viewGeminiDocs')}
                                                </Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                )}

                                <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
                                    {(() => {
                                        const selectedProfile = useProfiles && selectedProfileId
                                            ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
                                            : null;

                                        const options: Array<{
                                            key: 'claude' | 'codex' | 'gemini';
                                            title: string;
                                            subtitle: string;
                                            icon: React.ComponentProps<typeof Ionicons>['name'];
                                        }> = [
                                            { key: 'claude', title: t('agentInput.agent.claude'), subtitle: t('profiles.aiBackend.claudeSubtitle'), icon: 'sparkles-outline' },
                                            { key: 'codex', title: t('agentInput.agent.codex'), subtitle: t('profiles.aiBackend.codexSubtitle'), icon: 'terminal-outline' },
                                            ...(allowGemini ? [{ key: 'gemini' as const, title: t('agentInput.agent.gemini'), subtitle: t('profiles.aiBackend.geminiSubtitleExperimental'), icon: 'planet-outline' as const }] : []),
                                        ];

                                        return options.map((option, index) => {
                                            const compatible = !selectedProfile || !!selectedProfile.compatibility?.[option.key];
                                            const cliOk = cliAvailability[option.key] !== false;
                                            const disabledReason = !compatible
                                                ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                                                : !cliOk
                                                    ? t('newSession.aiBackendCliNotDetectedOnMachine', { cli: option.title })
                                                    : null;

                                            const isSelected = agentType === option.key;

                                            return (
                                                <Item
                                                    key={option.key}
                                                    title={option.title}
                                                    subtitle={disabledReason ?? option.subtitle}
                                                    leftElement={<Ionicons name={option.icon} size={24} color={theme.colors.textSecondary} />}
                                                    selected={isSelected}
                                                    disabled={!!disabledReason}
                                                    onPress={() => {
                                                        if (disabledReason) {
                                                            Modal.alert(
                                                                t('profiles.aiBackend.title'),
                                                                disabledReason,
                                                                compatible
                                                                    ? [{ text: t('common.ok'), style: 'cancel' }]
                                                                    : [
                                                                        { text: t('common.ok'), style: 'cancel' },
                                                                        ...(useProfiles && selectedProfileId ? [{ text: t('newSession.changeProfile'), onPress: handleAgentInputProfileClick }] : []),
                                                                    ],
                                                            );
                                                            return;
                                                        }
                                                        setAgentType(option.key);
                                                    }}
                                                    rightElement={(
                                                        <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                            <Ionicons
                                                                name="checkmark-circle"
                                                                size={24}
                                                                color={selectedIndicatorColor}
                                                                style={{ opacity: isSelected ? 1 : 0 }}
                                                            />
                                                        </View>
                                                    )}
                                                    showChevron={false}
                                                    showDivider={index < options.length - 1}
                                                />
                                            );
                                        });
                                    })()}
                                </ItemGroup>

                                {modelOptions.length > 0 && (
                                    <View style={{ marginTop: 24 }}>
                                        <View onLayout={registerWizardSectionOffset('model')}>
                                            <View style={styles.wizardSectionHeaderRow}>
                                                <Ionicons name="sparkles-outline" size={18} color={theme.colors.text} />
                                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectModelTitle')}</Text>
                                            </View>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectModelDescription')}
                                        </Text>
                                        <ItemGroup title="">
                                            {modelOptions.map((option, index, options) => {
                                                const isSelected = modelMode === option.value;
                                                return (
                                                    <Item
                                                        key={option.value}
                                                        title={option.label}
                                                        subtitle={option.description}
                                                        leftElement={<Ionicons name="sparkles-outline" size={24} color={theme.colors.textSecondary} />}
                                                        showChevron={false}
                                                        selected={isSelected}
                                                        onPress={() => setModelMode(option.value)}
                                                        rightElement={(
                                                            <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                                <Ionicons
                                                                    name="checkmark-circle"
                                                                    size={24}
                                                                    color={selectedIndicatorColor}
                                                                    style={{ opacity: isSelected ? 1 : 0 }}
                                                                />
                                                            </View>
                                                        )}
                                                        showDivider={index < options.length - 1}
                                                    />
                                                );
                                            })}
                                        </ItemGroup>
                                    </View>
                                )}

                                <View style={{ height: 24 }} />

                                {/* Section 2: Machine Selection */}
                                <View onLayout={registerWizardSectionOffset('machine')}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <View style={styles.wizardSectionHeaderRow}>
                                            <Ionicons name="desktop-outline" size={18} color={theme.colors.text} />
                                            <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectMachineTitle')}</Text>
                                        </View>
                                        {onRefreshMachines ? (
                                            <Pressable
                                                onPress={onRefreshMachines}
                                                hitSlop={10}
                                                style={{ padding: 2 }}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('common.refresh')}
                                            >
                                                <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        ) : null}
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectMachineDescription')}
                                </Text>

                                <View style={{ marginBottom: 24 }}>
                                    <MachineSelector
                                        machines={machines}
                                        selectedMachine={selectedMachine || null}
                                        recentMachines={recentMachines}
                                        favoriteMachines={favoriteMachineItems}
                                        showCliGlyphs={true}
                                        autoDetectCliGlyphs={false}
                                        showFavorites={true}
                                        showSearch={useMachinePickerSearch}
                                        searchPlacement="all"
                                        searchPlaceholder="Search machines..."
                                        onSelect={(machine) => {
                                            setSelectedMachineId(machine.id);
                                            const bestPath = getBestPathForMachine(machine.id);
                                            setSelectedPath(bestPath);
                                        }}
                                        onToggleFavorite={(machine) => {
                                            const isInFavorites = favoriteMachines.includes(machine.id);
                                            if (isInFavorites) {
                                                setFavoriteMachines(favoriteMachines.filter(id => id !== machine.id));
                                            } else {
                                                setFavoriteMachines([...favoriteMachines, machine.id]);
                                            }
                                        }}
                                    />
                                </View>

                                {/* API key selection is now handled inline from the profile list (via the requirements badge). */}

                                {/* Section 3: Working Directory */}
                                <View onLayout={registerWizardSectionOffset('path')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        <Ionicons name="folder-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectWorkingDirectoryTitle')}</Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectWorkingDirectoryDescription')}
                                </Text>

                                <View style={{ marginBottom: 24 }}>
                                    <PathSelector
                                        machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                                        selectedPath={selectedPath}
                                        onChangeSelectedPath={setSelectedPath}
                                        recentPaths={recentPaths}
                                        usePickerSearch={usePathPickerSearch}
                                        searchVariant="group"
                                        focusInputOnSelect={false}
                                        favoriteDirectories={favoriteDirectories}
                                        onChangeFavoriteDirectories={setFavoriteDirectories}
                                    />
                                </View>

                                {/* Section 4: Permission Mode */}
                                <View onLayout={registerWizardSectionOffset('permission')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        <Ionicons name="shield-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectPermissionModeTitle')}</Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectPermissionModeDescription')}
                                </Text>
                                <ItemGroup title="">
                                    {(agentType === 'codex' || agentType === 'gemini'
                                        ? [
                                            { value: 'default' as PermissionMode, label: t(agentType === 'codex' ? 'agentInput.codexPermissionMode.default' : 'agentInput.geminiPermissionMode.default'), description: 'Use CLI permission settings', icon: 'shield-outline' },
                                            { value: 'read-only' as PermissionMode, label: t(agentType === 'codex' ? 'agentInput.codexPermissionMode.readOnly' : 'agentInput.geminiPermissionMode.readOnly'), description: 'Read-only mode', icon: 'eye-outline' },
                                            { value: 'safe-yolo' as PermissionMode, label: t(agentType === 'codex' ? 'agentInput.codexPermissionMode.safeYolo' : 'agentInput.geminiPermissionMode.safeYolo'), description: 'Workspace write with approval', icon: 'shield-checkmark-outline' },
                                            { value: 'yolo' as PermissionMode, label: t(agentType === 'codex' ? 'agentInput.codexPermissionMode.yolo' : 'agentInput.geminiPermissionMode.yolo'), description: 'Full access, skip permissions', icon: 'flash-outline' },
                                        ]
                                        : [
                                            { value: 'default' as PermissionMode, label: t('agentInput.permissionMode.default'), description: 'Ask for permissions', icon: 'shield-outline' },
                                            { value: 'acceptEdits' as PermissionMode, label: t('agentInput.permissionMode.acceptEdits'), description: 'Auto-approve edits', icon: 'checkmark-outline' },
                                            { value: 'plan' as PermissionMode, label: t('agentInput.permissionMode.plan'), description: 'Plan before executing', icon: 'list-outline' },
                                            { value: 'bypassPermissions' as PermissionMode, label: t('agentInput.permissionMode.bypassPermissions'), description: 'Skip all permissions', icon: 'flash-outline' },
                                        ]
                                    ).map((option, index, array) => (
                                        <Item
                                            key={option.value}
                                            title={option.label}
                                            subtitle={option.description}
                                            leftElement={
                                                <Ionicons
                                                    name={option.icon as any}
                                                    size={24}
                                                    color={theme.colors.textSecondary}
                                                />
                                            }
                                            rightElement={permissionMode === option.value ? (
                                                <Ionicons
                                                    name="checkmark-circle"
                                                    size={24}
                                                    color={selectedIndicatorColor}
                                                />
                                            ) : null}
                                            onPress={() => handlePermissionModeChange(option.value)}
                                            showChevron={false}
                                            selected={permissionMode === option.value}
                                            showDivider={index < array.length - 1}
                                        />
                                    ))}
                                </ItemGroup>

                                <View style={{ height: 24 }} />

                                {/* Section 5: Session Type */}
                                {showSessionTypeSelector && (
                                    <>
                                        <View onLayout={registerWizardSectionOffset('sessionType')}>
                                            <View style={styles.wizardSectionHeaderRow}>
                                                <Ionicons name="layers-outline" size={18} color={theme.colors.text} />
                                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectSessionTypeTitle')}</Text>
                                            </View>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectSessionTypeDescription')}
                                        </Text>

                                        <View style={{ marginBottom: 0 }}>
                                            <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
                                                <SessionTypeSelectorRows value={sessionType} onChange={setSessionType} />
                                            </ItemGroup>
                                        </View>
                                    </>
                                )}
                            </View>
                        </View>
                    </View>
                </ScrollView>

                {/* AgentInput - Sticky at bottom */}
                <View style={{
                    paddingTop: 12,
                    paddingBottom: newSessionBottomPadding,
                    position: 'relative',
                    overflow: 'visible',
                    ...Platform.select({
                        web: { boxShadow: '0 -10px 30px rgba(0,0,0,0.08)' } as any,
                        ios: {
                            shadowColor: theme.colors.shadow.color,
                            shadowOffset: { width: 0, height: -4 },
                            shadowOpacity: 0.08,
                            shadowRadius: 14,
                        },
                        android: { borderTopWidth: 1, borderTopColor: theme.colors.divider },
                        default: {},
                    }),
                }}>
                    {/* Always-on top divider gradient (wizard only).
                        Matches web: boxShadow 0 -10px 30px rgba(0,0,0,0.08) and fades into true transparency above. */}
                    {Platform.OS !== 'web' ? (
                        <LinearGradient
                            pointerEvents="none"
                            colors={[
                                (() => {
                                    try {
                                        return Color(theme.colors.shadow.color).alpha(0.08).rgb().string();
                                    } catch {
                                        return 'rgba(0,0,0,0.08)';
                                    }
                                })(),
                                'transparent',
                            ]}
                            start={{ x: 0.5, y: 1 }}
                            end={{ x: 0.5, y: 0 }}
                            style={{
                                position: 'absolute',
                                top: -30,
                                left: -1000,
                                right: -1000,
                                height: 30,
                                zIndex: 10,
                            }}
                        />
                    ) : null}
                    <View style={{ paddingHorizontal: newSessionSidePadding }}>
                        <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                            <AgentInput
                                value={sessionPrompt}
                                onChangeText={setSessionPrompt}
                                onSend={handleCreateSession}
                                isSendDisabled={!canCreate}
                                isSending={isCreating}
                                placeholder={t('session.inputPlaceholder')}
                                autocompletePrefixes={emptyAutocompletePrefixes}
                                autocompleteSuggestions={emptyAutocompleteSuggestions}
                                agentType={agentType}
                                onAgentClick={handleAgentInputAgentClick}
                                permissionMode={permissionMode}
                                onPermissionClick={handleAgentInputPermissionClick}
                                modelMode={modelMode}
                                onModelModeChange={setModelMode}
                                connectionStatus={connectionStatus}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                onMachineClick={handleAgentInputMachineClick}
                                currentPath={selectedPath}
                                onPathClick={handleAgentInputPathClick}
                                contentPaddingHorizontal={0}
                                {...(useProfiles ? {
                                    profileId: selectedProfileId,
                                                onProfileClick: handleAgentInputProfileClick,
                                    envVarsCount: selectedProfileEnvVarsCount || undefined,
                                    onEnvVarsClick: selectedProfileEnvVarsCount > 0 ? handleEnvVarsClick : undefined,
                                } : {})}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
});
