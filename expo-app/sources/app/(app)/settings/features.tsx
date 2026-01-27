import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { Switch } from '@/components/Switch';
import { t } from '@/text';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog';

export default React.memo(function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [experimentalAgents, setExperimentalAgents] = useSettingMutable('experimentalAgents');
    const [expUsageReporting, setExpUsageReporting] = useSettingMutable('expUsageReporting');
    const [expFileViewer, setExpFileViewer] = useSettingMutable('expFileViewer');
    const [expShowThinkingMessages, setExpShowThinkingMessages] = useSettingMutable('expShowThinkingMessages');
    const [expSessionType, setExpSessionType] = useSettingMutable('expSessionType');
    const [expZen, setExpZen] = useSettingMutable('expZen');
    const [expVoiceAuthFlow, setExpVoiceAuthFlow] = useSettingMutable('expVoiceAuthFlow');
    const [expInboxFriends, setExpInboxFriends] = useSettingMutable('expInboxFriends');
    const [expCodexResume, setExpCodexResume] = useSettingMutable('expCodexResume');
    const [expCodexAcp, setExpCodexAcp] = useSettingMutable('expCodexAcp');
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [groupInactiveSessionsByProject, setGroupInactiveSessionsByProject] = useSettingMutable('groupInactiveSessionsByProject');
    const [useEnhancedSessionWizard, setUseEnhancedSessionWizard] = useSettingMutable('useEnhancedSessionWizard');
    const [useMachinePickerSearch, setUseMachinePickerSearch] = useSettingMutable('useMachinePickerSearch');
    const [usePathPickerSearch, setUsePathPickerSearch] = useSettingMutable('usePathPickerSearch');

    const setAllExperimentToggles = React.useCallback((enabled: boolean) => {
        const nextExperimentalAgents: Record<string, boolean> = { ...(experimentalAgents ?? {}) };
        for (const id of AGENT_IDS) {
            if (getAgentCore(id).availability.experimental) {
                nextExperimentalAgents[id] = enabled;
            }
        }
        setExperimentalAgents(nextExperimentalAgents as any);
        setExpUsageReporting(enabled);
        setExpFileViewer(enabled);
        setExpShowThinkingMessages(enabled);
        setExpSessionType(enabled);
        setExpZen(enabled);
        setExpVoiceAuthFlow(enabled);
        setExpInboxFriends(enabled);
        // Intentionally NOT auto-enabled: these require additional local installs and have extra surface area.
        setExpCodexResume(false);
        setExpCodexAcp(false);
    }, [
        setExpCodexAcp,
        setExpCodexResume,
        setExpFileViewer,
        setExpInboxFriends,
        setExpSessionType,
        setExpShowThinkingMessages,
        setExpUsageReporting,
        setExpVoiceAuthFlow,
        setExpZen,
        experimentalAgents,
        setExperimentalAgents,
    ]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Standard feature toggles first */}
            <ItemGroup>
                <Item
                    title={t('settingsFeatures.markdownCopyV2')}
                    subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
                    icon={<Ionicons name="text-outline" size={29} color="#34C759" />}
                    rightElement={<Switch value={markdownCopyV2} onValueChange={setMarkdownCopyV2} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.groupInactiveSessionsByProject')}
                    subtitle={t('settingsFeatures.groupInactiveSessionsByProjectSubtitle')}
                    icon={<Ionicons name="folder-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={groupInactiveSessionsByProject} onValueChange={setGroupInactiveSessionsByProject} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.enhancedSessionWizard')}
                    subtitle={useEnhancedSessionWizard
                        ? t('settingsFeatures.enhancedSessionWizardEnabled')
                        : t('settingsFeatures.enhancedSessionWizardDisabled')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#AF52DE" />}
                    rightElement={<Switch value={useEnhancedSessionWizard} onValueChange={setUseEnhancedSessionWizard} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.machinePickerSearch')}
                    subtitle={t('settingsFeatures.machinePickerSearchSubtitle')}
                    icon={<Ionicons name="search-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={useMachinePickerSearch} onValueChange={setUseMachinePickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.pathPickerSearch')}
                    subtitle={t('settingsFeatures.pathPickerSearchSubtitle')}
                    icon={<Ionicons name="folder-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={usePathPickerSearch} onValueChange={setUsePathPickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.profiles')}
                    subtitle={useProfiles
                        ? t('settingsFeatures.profilesEnabled')
                        : t('settingsFeatures.profilesDisabled')}
                    icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                    rightElement={<Switch value={useProfiles} onValueChange={setUseProfiles} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Web-only Features */}
            {Platform.OS === 'web' && (
                <ItemGroup
                    title={t('settingsFeatures.webFeatures')}
                    footer={t('settingsFeatures.webFeaturesDescription')}
                >
                    <Item
                        title={t('settingsFeatures.enterToSend')}
                        subtitle={agentInputEnterToSend ? t('settingsFeatures.enterToSendEnabled') : t('settingsFeatures.enterToSendDisabled')}
                        icon={<Ionicons name="return-down-forward-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={agentInputEnterToSend} onValueChange={setAgentInputEnterToSend} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Experiments last */}
            <ItemGroup
                title={t('settingsFeatures.experiments')}
                footer={t('settingsFeatures.experimentsDescription')}
            >
                <Item
                    title={t('settingsFeatures.experimentalFeatures')}
                    subtitle={experiments ? t('settingsFeatures.experimentalFeaturesEnabled') : t('settingsFeatures.experimentalFeaturesDisabled')}
                    icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={experiments}
                            onValueChange={(next) => {
                                setExperiments(next);
                                // Requirement: toggling the master switch enables/disables all experiments by default.
                                setAllExperimentToggles(next);
                            }}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {experiments && (
                <ItemGroup
                    title={t('settingsFeatures.experimentalOptions')}
                    footer={t('settingsFeatures.experimentalOptionsDescription')}
                >
                    {AGENT_IDS.filter((id) => getAgentCore(id).availability.experimental).map((agentId) => {
                        const enabled = experimentalAgents?.[agentId] === true;
                        const icon = getAgentCore(agentId).ui.agentPickerIconName as React.ComponentProps<typeof Ionicons>['name'];
                        return (
                            <Item
                                key={agentId}
                                title={t(getAgentCore(agentId).displayNameKey)}
                                subtitle={t(getAgentCore(agentId).subtitleKey)}
                                icon={<Ionicons name={icon} size={29} color="#007AFF" />}
                                rightElement={
                                    <Switch
                                        value={enabled}
                                        onValueChange={(next) => {
                                            setExperimentalAgents({
                                                ...(experimentalAgents ?? {}),
                                                [agentId]: next,
                                            } as any);
                                        }}
                                    />
                                }
                                showChevron={false}
                            />
                        );
                    })}
                    <Item
                        title={t('settingsFeatures.expUsageReporting')}
                        subtitle={t('settingsFeatures.expUsageReportingSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={expUsageReporting} onValueChange={setExpUsageReporting} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expFileViewer')}
                        subtitle={t('settingsFeatures.expFileViewerSubtitle')}
                        icon={<Ionicons name="folder-open-outline" size={29} color="#FF9500" />}
                        rightElement={<Switch value={expFileViewer} onValueChange={setExpFileViewer} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expShowThinkingMessages')}
                        subtitle={t('settingsFeatures.expShowThinkingMessagesSubtitle')}
                        icon={<Ionicons name="chatbubbles-outline" size={29} color="#34C759" />}
                        rightElement={<Switch value={expShowThinkingMessages} onValueChange={setExpShowThinkingMessages} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expSessionType')}
                        subtitle={t('settingsFeatures.expSessionTypeSubtitle')}
                        icon={<Ionicons name="layers-outline" size={29} color="#AF52DE" />}
                        rightElement={<Switch value={expSessionType} onValueChange={setExpSessionType} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expZen')}
                        subtitle={t('settingsFeatures.expZenSubtitle')}
                        icon={<Ionicons name="leaf-outline" size={29} color="#34C759" />}
                        rightElement={<Switch value={expZen} onValueChange={setExpZen} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expVoiceAuthFlow')}
                        subtitle={t('settingsFeatures.expVoiceAuthFlowSubtitle')}
                        icon={<Ionicons name="mic-outline" size={29} color="#FF3B30" />}
                        rightElement={<Switch value={expVoiceAuthFlow} onValueChange={setExpVoiceAuthFlow} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expInboxFriends')}
                        subtitle={t('settingsFeatures.expInboxFriendsSubtitle')}
                        icon={<Ionicons name="people-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={expInboxFriends} onValueChange={setExpInboxFriends} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expCodexResume')}
                        subtitle={t('settingsFeatures.expCodexResumeSubtitle')}
                        icon={<Ionicons name="sparkles-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch
                            value={expCodexResume}
                            onValueChange={(next) => {
                                setExpCodexResume(next);
                                if (next) {
                                    // Mutually exclusive: ACP makes the vendor-resume MCP fork unnecessary.
                                    setExpCodexAcp(false);
                                }
                            }}
                        />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expCodexAcp')}
                        subtitle={t('settingsFeatures.expCodexAcpSubtitle')}
                        icon={<Ionicons name="sparkles-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch
                            value={expCodexAcp}
                            onValueChange={(next) => {
                                setExpCodexAcp(next);
                                if (next) {
                                    // Mutually exclusive: ACP replaces the resume-specific MCP fork.
                                    setExpCodexResume(false);
                                }
                            }}
                        />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
