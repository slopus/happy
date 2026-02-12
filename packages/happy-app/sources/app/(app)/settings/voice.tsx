import { useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import { Switch } from '@/components/Switch';
import { isVoiceSessionStarted, stopRealtimeSession } from '@/realtime/RealtimeSession';
import {
    getVoiceProvider,
    setVoiceProvider,
    getElevenLabsAgentId,
    hasCustomElevenLabsAgentId,
    getHappyVoiceGatewayUrl,
    hasCustomHappyVoiceGatewayUrl,
    getHappyVoicePublicKey,
    hasCustomHappyVoicePublicKey,
    getSendConfirmation,
    setSendConfirmation,
    getSendConfirmationSpeed,
    setSendConfirmationSpeed,
    type SendConfirmationSpeed,
} from '@/sync/voiceConfig';

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

export default function VoiceSettingsScreen() {
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    // Local state that refreshes when returning from sub-pages
    const [provider, setProvider] = useState(() => getVoiceProvider());
    const [agentId, setAgentId] = useState(() => getElevenLabsAgentId());
    const [gatewayUrl, setGatewayUrl] = useState(() => getHappyVoiceGatewayUrl());
    const [publicKey, setPublicKey] = useState(() => getHappyVoicePublicKey());
    const [sendConfirmationEnabled, setSendConfirmationEnabled] = useState(() => getSendConfirmation());
    const [confirmationSpeed, setConfirmationSpeed] = useState<SendConfirmationSpeed>(() => getSendConfirmationSpeed());

    useFocusEffect(
        useCallback(() => {
            setProvider(getVoiceProvider());
            setAgentId(getElevenLabsAgentId());
            setGatewayUrl(getHappyVoiceGatewayUrl());
            setPublicKey(getHappyVoicePublicKey());
            setSendConfirmationEnabled(getSendConfirmation());
            setConfirmationSpeed(getSendConfirmationSpeed());
        }, []),
    );

    const handleProviderChange = async (value: 'elevenlabs' | 'happy-voice') => {
        if (isVoiceSessionStarted()) {
            await stopRealtimeSession();
        }
        setVoiceProvider(value);
        setProvider(value);
    };

    const handleSendConfirmationChange = (value: boolean) => {
        setSendConfirmation(value);
        setSendConfirmationEnabled(value);
    };

    const handleSpeedChange = (value: SendConfirmationSpeed) => {
        setSendConfirmationSpeed(value);
        setConfirmationSpeed(value);
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Provider Selection */}
            <ItemGroup
                title={t('settingsVoice.providerTitle')}
                footer={t('settingsVoice.providerDescription')}
            >
                <Item
                    title="Happy Voice"
                    subtitle={t('settingsVoice.providerHappyVoiceSubtitle')}
                    icon={<Ionicons name="sparkles" size={29} color="#34C759" />}
                    rightElement={
                        provider === 'happy-voice'
                            ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                            : null
                    }
                    onPress={() => handleProviderChange('happy-voice')}
                    showChevron={false}
                />
                <Item
                    title="ElevenLabs"
                    subtitle={t('settingsVoice.providerElevenLabsSubtitle')}
                    icon={<Ionicons name="cloud-outline" size={29} color="#007AFF" />}
                    rightElement={
                        provider === 'elevenlabs'
                            ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                            : null
                    }
                    onPress={() => handleProviderChange('elevenlabs')}
                    showChevron={false}
                />
            </ItemGroup>

            {/* ElevenLabs Configuration */}
            {provider === 'elevenlabs' && (
                <ItemGroup
                    title={t('settingsVoice.elevenLabsTitle')}
                    footer={t('settingsVoice.elevenLabsDescription')}
                >
                    <Item
                        title={t('settingsVoice.agentId')}
                        icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                        detail={agentId ? truncate(agentId, 20) : t('settingsVoice.notConfigured')}
                        subtitle={hasCustomElevenLabsAgentId() ? t('settingsVoice.usingCustomConfig') : t('settingsVoice.usingDefaultConfig')}
                        onPress={() => router.push('/settings/voice/elevenlabs')}
                    />
                </ItemGroup>
            )}

            {/* Happy Voice Configuration */}
            {provider === 'happy-voice' && (
                <ItemGroup
                    title={t('settingsVoice.happyVoiceTitle')}
                    footer={t('settingsVoice.happyVoiceDescription')}
                >
                    <Item
                        title={t('settingsVoice.gatewayUrl')}
                        icon={<Ionicons name="link-outline" size={29} color="#5856D6" />}
                        detail={gatewayUrl ? truncate(gatewayUrl, 25) : t('settingsVoice.notConfigured')}
                        subtitle={hasCustomHappyVoiceGatewayUrl() ? t('settingsVoice.usingCustomConfig') : t('settingsVoice.usingDefaultConfig')}
                        onPress={() => router.push('/settings/voice/happy-voice')}
                    />
                    <Item
                        title={t('settingsVoice.publicKey')}
                        icon={<Ionicons name="shield-outline" size={29} color="#FF2D55" />}
                        detail={publicKey ? '********' : t('settingsVoice.notConfigured')}
                        subtitle={hasCustomHappyVoicePublicKey() ? t('settingsVoice.usingCustomConfig') : t('settingsVoice.usingDefaultConfig')}
                        onPress={() => router.push('/settings/voice/happy-voice')}
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
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Send Confirmation */}
            <ItemGroup
                title={t('settingsVoice.sendConfirmationTitle')}
                footer={t('settingsVoice.sendConfirmationDescription')}
            >
                <Item
                    title={t('settingsVoice.sendConfirmationLabel')}
                    subtitle={t('settingsVoice.sendConfirmationSubtitle')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                    rightElement={
                        <Switch
                            value={sendConfirmationEnabled}
                            onValueChange={handleSendConfirmationChange}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Confirmation Speed */}
            {sendConfirmationEnabled && (
                <ItemGroup
                    title={t('settingsVoice.sendConfirmationSpeedTitle')}
                >
                    <Item
                        title={t('settingsVoice.speedFast')}
                        icon={<Ionicons name="flash-outline" size={29} color="#FF9500" />}
                        rightElement={
                            confirmationSpeed === 'fast'
                                ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                : null
                        }
                        onPress={() => handleSpeedChange('fast')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsVoice.speedNormal')}
                        icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                        rightElement={
                            confirmationSpeed === 'normal'
                                ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                : null
                        }
                        onPress={() => handleSpeedChange('normal')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsVoice.speedSlow')}
                        icon={<Ionicons name="hourglass-outline" size={29} color="#5856D6" />}
                        rightElement={
                            confirmationSpeed === 'slow'
                                ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                : null
                        }
                        onPress={() => handleSpeedChange('slow')}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
