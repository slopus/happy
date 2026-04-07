import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import { Modal } from '@/modal';

const PROVIDER_LABELS: Record<string, string> = {
    elevenlabs: 'ElevenLabs',
    openai: 'OpenAI GPT-4o',
};

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceBackend] = useSettingMutable('voiceBackend');
    const [openaiKey, setOpenaiKey] = useSettingMutable('inferenceOpenAIKey');
    const [pushToTalk, setPushToTalk] = useSettingMutable('voicePushToTalk');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');
    const [keyVisible, setKeyVisible] = useState(false);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleCustomAgentId = async () => {
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
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Provider */}
            <ItemGroup
                title={t('settingsVoice.backendTitle')}
                footer={t('settingsVoice.backendDescription')}
            >
                <Item
                    title={t('settingsVoice.backendTitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#007AFF" />}
                    detail={PROVIDER_LABELS[voiceBackend] ?? voiceBackend}
                    onPress={() => router.push('/settings/voice/provider')}
                />
            </ItemGroup>

            {/* OpenAI API Key - only shown when OpenAI backend is selected */}
            {voiceBackend === 'openai' && (
                <ItemGroup
                    title={t('settingsVoice.apiKeyTitle')}
                    footer={t('settingsVoice.apiKeyDescription')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Ionicons name="key-outline" size={29} color="#007AFF" style={{ marginRight: 12 }} />
                        <TextInput
                            style={{
                                flex: 1,
                                fontSize: 16,
                                color: theme.colors.text,
                            }}
                            placeholder={t('settingsVoice.apiKeyPlaceholder')}
                            placeholderTextColor={theme.colors.input?.placeholder ?? '#999'}
                            value={openaiKey ?? ''}
                            onChangeText={(text) => setOpenaiKey(text || null)}
                            secureTextEntry={!keyVisible}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                        />
                        <Ionicons
                            name={keyVisible ? 'eye-off-outline' : 'eye-outline'}
                            size={22}
                            color={theme.colors.textSecondary}
                            onPress={() => setKeyVisible(!keyVisible)}
                            style={{ marginLeft: 8, padding: 4 }}
                        />
                    </View>
                </ItemGroup>
            )}

            {/* Push-to-Talk - only shown when OpenAI backend is selected */}
            {voiceBackend === 'openai' && (
                <ItemGroup
                    title={t('settingsVoice.pushToTalkTitle')}
                    footer={t('settingsVoice.pushToTalkDescription')}
                >
                    <Item
                        title={t('settingsVoice.pushToTalkTitle')}
                        icon={<Ionicons name="hand-left-outline" size={29} color="#007AFF" />}
                        rightElement={
                            <Switch
                                value={pushToTalk}
                                onValueChange={setPushToTalk}
                            />
                        }
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

            {/* Bring Your Own Agent — only shown for ElevenLabs */}
            {voiceBackend === 'elevenlabs' && (
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
            )}

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceBackend === 'elevenlabs' && voiceCustomAgentId && (
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
}
