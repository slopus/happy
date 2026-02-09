import { useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import {
    getVoiceProvider,
    setVoiceProvider,
    getElevenLabsAgentId,
    hasCustomElevenLabsAgentId,
    getLiveKitGatewayUrl,
    hasCustomLiveKitGatewayUrl,
    getLiveKitPublicKey,
    hasCustomLiveKitPublicKey,
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
    const [gatewayUrl, setGatewayUrl] = useState(() => getLiveKitGatewayUrl());
    const [publicKey, setPublicKey] = useState(() => getLiveKitPublicKey());

    useFocusEffect(
        useCallback(() => {
            setProvider(getVoiceProvider());
            setAgentId(getElevenLabsAgentId());
            setGatewayUrl(getLiveKitGatewayUrl());
            setPublicKey(getLiveKitPublicKey());
        }, []),
    );

    const handleProviderChange = (value: 'elevenlabs' | 'livekit') => {
        setVoiceProvider(value);
        setProvider(value);
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Provider Selection */}
            <ItemGroup
                title={t('settingsVoice.providerTitle')}
                footer={t('settingsVoice.providerDescription')}
            >
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
                <Item
                    title="Happy Voice"
                    subtitle={t('settingsVoice.providerHappyVoiceSubtitle')}
                    icon={<Ionicons name="server-outline" size={29} color="#34C759" />}
                    rightElement={
                        provider === 'livekit'
                            ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                            : null
                    }
                    onPress={() => handleProviderChange('livekit')}
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

            {/* Happy Voice (LiveKit) Configuration */}
            {provider === 'livekit' && (
                <ItemGroup
                    title={t('settingsVoice.happyVoiceTitle')}
                    footer={t('settingsVoice.happyVoiceDescription')}
                >
                    <Item
                        title={t('settingsVoice.gatewayUrl')}
                        icon={<Ionicons name="link-outline" size={29} color="#5856D6" />}
                        detail={gatewayUrl ? truncate(gatewayUrl, 25) : t('settingsVoice.notConfigured')}
                        subtitle={hasCustomLiveKitGatewayUrl() ? t('settingsVoice.usingCustomConfig') : t('settingsVoice.usingDefaultConfig')}
                        onPress={() => router.push('/settings/voice/livekit')}
                    />
                    <Item
                        title={t('settingsVoice.publicKey')}
                        icon={<Ionicons name="shield-outline" size={29} color="#FF2D55" />}
                        detail={publicKey ? '********' : t('settingsVoice.notConfigured')}
                        subtitle={hasCustomLiveKitPublicKey() ? t('settingsVoice.usingCustomConfig') : t('settingsVoice.usingDefaultConfig')}
                        onPress={() => router.push('/settings/voice/livekit')}
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
        </ItemList>
    );
}
