import React from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { UsageBar } from '@/components/usage/UsageBar';
import { useSettingMutable, useEntitlement, useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { fetchVoiceUsage, type VoiceUsageResponse } from '@/sync/apiVoice';
import { t } from '@/text';
import { useSettingsRouter } from '@/components/DesktopSettingsNavigation';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import {
    getVoiceExperimentStatus,
    type VoiceUpsellVariant,
    type VoiceUpsellVariantSource,
} from '@/realtime/voiceExperiment';
import { getVoiceLocalCounters, resetVoiceLocalCounters } from '@/sync/persistence';

function formatVoiceTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

function getVoiceUpsellVariantTranslation(variant: VoiceUpsellVariant): string {
    switch (variant) {
        case 'control':
            return t('settingsVoice.experimentOverrideControl');
        case 'show-paywall-before-first-voice-chat':
            return t('settingsVoice.experimentOverrideSoftPaywall');
        case 'voice-onboarding-and-upsell':
            return t('settingsVoice.experimentOverrideOnboardingUpsell');
    }
}

function getVoiceExperimentSourceTranslation(source: VoiceUpsellVariantSource): string {
    switch (source) {
        case 'override':
            return t('settingsVoice.experimentSourceOverride');
        case 'posthog':
            return t('settingsVoice.experimentSourcePosthog');
        case 'default':
            return t('settingsVoice.experimentSourceDefault');
    }
}

export default React.memo(function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useSettingsRouter();
    const auth = useAuth();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');
    const [voiceUpsellOverride, setVoiceUpsellOverride] = useLocalSettingMutable('voiceUpsellOverride');
    const experiments = useSetting('experiments');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');

    const hasPro = useEntitlement('pro');

    const [usage, setUsage] = React.useState<VoiceUsageResponse | null>(null);
    const [usageLoading, setUsageLoading] = React.useState(true);
    const [voiceLocalCounters, setVoiceLocalCounters] = React.useState(() => getVoiceLocalCounters());

    React.useEffect(() => {
        if (!auth.credentials) return;
        fetchVoiceUsage(auth.credentials)
            .then(setUsage)
            .catch(() => {})
            .finally(() => setUsageLoading(false));
    }, [auth.credentials]);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleSupportUs = React.useCallback(async () => {
        trackPaywallButtonClicked('voluntary_support');
        await sync.presentPaywall('voluntary_support');
    }, []);

    const handleCustomAgentId = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsVoice.customAgentId'),
            t('settingsVoice.customAgentIdDescription'),
            {
                defaultValue: voiceCustomAgentId ?? '',
                placeholder: t('settingsVoice.customAgentIdPlaceholder'),
            }
        );
        if (value !== null) {
            const trimmed = value.trim() || null;
            setVoiceCustomAgentId(trimmed);
            // Auto-toggle bypass when setting/clearing agent ID
            setVoiceBypassToken(trimmed !== null);
        }
    }, [voiceCustomAgentId, setVoiceCustomAgentId, setVoiceBypassToken]);

    const handleVoiceExperimentOverride = React.useCallback(() => {
        Modal.alert(
            t('settingsVoice.experimentOverrideTitle'),
            t('settingsVoice.experimentOverrideDescription'),
            [
                { text: t('settingsVoice.experimentOverrideNone'), onPress: () => setVoiceUpsellOverride(null) },
                { text: t('settingsVoice.experimentOverrideControl'), onPress: () => setVoiceUpsellOverride('control') },
                { text: t('settingsVoice.experimentOverrideSoftPaywall'), onPress: () => setVoiceUpsellOverride('show-paywall-before-first-voice-chat') },
                { text: t('settingsVoice.experimentOverrideOnboardingUpsell'), onPress: () => setVoiceUpsellOverride('voice-onboarding-and-upsell') },
            ],
        );
    }, [setVoiceUpsellOverride]);

    const handleResetVoiceCounters = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('settingsVoice.resetCountersTitle'),
            t('settingsVoice.resetCountersMessage'),
            {
                confirmText: t('settingsVoice.resetCountersConfirm'),
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        resetVoiceLocalCounters();
        setVoiceLocalCounters(getVoiceLocalCounters());
    }, []);

    const voiceExperimentStatus = React.useMemo(() => {
        return getVoiceExperimentStatus({
            voiceBypassToken,
            voiceCustomAgentId,
            voiceUpsellOverride,
            voiceUpsellOverrideEnabled: devModeEnabled,
        });
    }, [devModeEnabled, voiceBypassToken, voiceCustomAgentId, voiceUpsellOverride]);

    const developerExperimentSubtitle = React.useMemo(() => {
        const upsellVariant = getVoiceUpsellVariantTranslation(voiceExperimentStatus.upsellVariant);
        const variantSource = getVoiceExperimentSourceTranslation(voiceExperimentStatus.upsellVariantSource);
        const gatingMode = voiceExperimentStatus.gatingMode === 'direct-byo-agent'
            ? t('settingsVoice.experimentStatusDirectByoAgent')
            : t('settingsVoice.experimentStatusServerGate');

        return [
            t('settingsVoice.experimentStatusVariant', { value: upsellVariant }),
            t('settingsVoice.experimentStatusSource', { value: variantSource }),
            t('settingsVoice.experimentStatusGate', { value: gatingMode }),
            t('settingsVoice.experimentStatusExperiments', { enabled: experiments }),
        ].join(Platform.OS === 'web' ? ' · ' : '\n');
    }, [experiments, voiceExperimentStatus]);

    const developerOverrideLabel = React.useMemo(() => {
        if (!voiceUpsellOverride) {
            return t('settingsVoice.experimentOverrideNone');
        }
        return getVoiceUpsellVariantTranslation(voiceUpsellOverride);
    }, [voiceUpsellOverride]);

    const developerCountersSubtitle = React.useMemo(() => {
        return [
            t('settingsVoice.counterSoftPaywallShown', { count: voiceLocalCounters.softPaywallShownCount }),
            t('settingsVoice.counterOnboardingPromptLoads', { count: voiceLocalCounters.onboardingPromptLoadCount }),
            t('settingsVoice.counterVoiceMessages', { count: voiceLocalCounters.voiceMessageCount }),
        ].join(Platform.OS === 'web' ? ' · ' : '\n');
    }, [voiceLocalCounters]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Usage */}
            {usageLoading ? (
                <View testID="voice-usage-loading" style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator />
                </View>
            ) : usage?.available ? (
                <ItemGroup
                    title={t('settingsVoice.usageTitle')}
                    footer={t('settingsVoice.usageFooter')}
                >
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        <UsageBar
                            label={t('settingsVoice.usageLabel')}
                            value={usage.usedSeconds}
                            maxValue={usage.limitSeconds}
                            color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : theme.colors.accent}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {formatVoiceTime(usage.usedSeconds)} / {formatVoiceTime(usage.limitSeconds)}
                        </Text>
                        <UsageBar
                            label={t('settingsVoice.conversationsLabel')}
                            value={usage.conversationCount}
                            maxValue={usage.conversationLimit}
                            color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : theme.colors.accent}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.conversationCount} / {usage.conversationLimit}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}

            {/* Support / Upgrade */}
            {!hasPro && (
                <ItemGroup>
                    <Item
                        title={t('settingsVoice.supportTitle')}
                        subtitle={t('settingsVoice.supportSubtitle')}
                        icon={<Ionicons name="heart-outline" size={29} color="#FF2D55" />}
                        onPress={handleSupportUs}
                    />
                </ItemGroup>
            )}

            {devModeEnabled && (
                <ItemGroup
                    title={t('settingsVoice.developerTitle')}
                    footer={t('settingsVoice.developerFooter')}
                >
                    <Item
                        title={t('settingsVoice.experimentOverrideTitle')}
                        subtitle={t('settingsVoice.experimentOverrideSubtitle')}
                        detail={developerOverrideLabel}
                        icon={<Ionicons name="options-outline" size={29} color={theme.colors.accent} />}
                        onPress={handleVoiceExperimentOverride}
                    />
                    <Item
                        title={t('settingsVoice.experimentStatusTitle')}
                        subtitle={developerExperimentSubtitle}
                        subtitleLines={Platform.OS === 'web' ? 2 : 0}
                        icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                        copy={developerExperimentSubtitle}
                        testID="voice-experiment-status-row"
                    />
                    <Item
                        title={t('settingsVoice.resetCountersTitle')}
                        subtitle={developerCountersSubtitle}
                        subtitleLines={Platform.OS === 'web' ? 2 : 0}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleResetVoiceCounters}
                        testID="voice-reset-counters-row"
                    />
                </ItemGroup>
            )}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.accent} />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Bring Your Own Agent */}
            <ItemGroup
                title={t('settingsVoice.byoTitle')}
                footer={t('settingsVoice.byoDescription')}
            >
                <Item
                    title={t('settingsVoice.customAgentId')}
                    subtitle={voiceCustomAgentId ?? t('settingsVoice.customAgentIdNotSet')}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={handleCustomAgentId}
                />
                <Item
                    title={t('settingsVoice.bypassToken')}
                    subtitle={t('settingsVoice.bypassTokenSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={voiceBypassToken}
                            onValueChange={setVoiceBypassToken}
                        />
                    }
                />
            </ItemGroup>

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceCustomAgentId && (
                <ItemGroup
                    title={t('settingsVoice.promptGuideTitle')}
                    footer={t('settingsVoice.promptGuideDescription')}
                >
                    <Item
                        title={t('settingsVoice.customAgentId')}
                        subtitle={voiceCustomAgentId}
                        copy={voiceCustomAgentId}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
