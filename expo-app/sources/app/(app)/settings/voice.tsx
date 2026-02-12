import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';

const PROVIDER_LABELS: Record<string, string> = {
    stepfun: 'StepFun',
    elevenlabs: 'ElevenLabs',
    none: 'None',
};

const STEPFUN_MODELS: Record<string, string> = {
    'step-audio-2': 'step-audio-2',
};

const STEPFUN_VOICES: Record<string, string> = {
    'qingchunshaonv': '青春少女 (Young Female)',
    'wenrounansheng': '温柔男声 (Gentle Male)',
    'elegantgentle-female': '优雅女声 (Elegant Female)',
    'livelybreezy-female': '活泼女声 (Lively Female)',
};

export default function VoiceSettingsScreen() {
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceAssistantSystemPrompt] = useSettingMutable('voiceAssistantSystemPrompt');
    const [voiceProvider] = useSettingMutable('voiceProvider');
    const [stepFunConfig] = useSettingMutable('voiceProviderStepFun');

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    // Get system prompt preview (truncated)
    const systemPromptPreview = voiceAssistantSystemPrompt
        ? (voiceAssistantSystemPrompt.length > 30
            ? voiceAssistantSystemPrompt.substring(0, 30) + '...'
            : voiceAssistantSystemPrompt)
        : t('settingsVoice.systemPromptDefault');

    // Get provider display name
    const providerDisplay = voiceProvider ? PROVIDER_LABELS[voiceProvider] : t('settingsVoice.providerNotConfigured');

    // Get StepFun model and voice display names
    const stepFunModelDisplay = stepFunConfig?.modelId
        ? STEPFUN_MODELS[stepFunConfig.modelId] || stepFunConfig.modelId
        : 'step-audio-2';
    const stepFunVoiceDisplay = stepFunConfig?.voice
        ? STEPFUN_VOICES[stepFunConfig.voice] || stepFunConfig.voice
        : '青春少女 (Young Female)';

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Provider Settings */}
            <ItemGroup
                title={t('settingsVoice.providerTitle')}
                footer={t('settingsVoice.providerDescription')}
            >
                <Item
                    title={t('settingsVoice.providerLabel')}
                    subtitle={t('settingsVoice.providerSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#FF9500" />}
                    detail={providerDisplay}
                    onPress={() => router.push('/settings/voice/provider')}
                />
            </ItemGroup>

            {/* StepFun Model & Voice Settings - shown when StepFun is selected */}
            {voiceProvider === 'stepfun' && (
                <ItemGroup
                    title={t('settingsVoice.provider.stepfunConfig')}
                    footer={t('settingsVoice.provider.stepfunConfigDescription')}
                >
                    <Item
                        title={t('settingsVoice.provider.model')}
                        subtitle={stepFunModelDisplay}
                        icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />}
                        onPress={() => router.push('/settings/voice/provider')}
                    />
                    <Item
                        title={t('settingsVoice.provider.voice')}
                        subtitle={stepFunVoiceDisplay}
                        icon={<Ionicons name="person-outline" size={29} color="#FF2D55" />}
                        onPress={() => router.push('/settings/voice/provider')}
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

            {/* System Prompt Settings */}
            <ItemGroup
                title={t('settingsVoice.systemPromptTitle')}
                footer={t('settingsVoice.systemPromptDescription')}
            >
                <Item
                    title={t('settingsVoice.systemPrompt')}
                    subtitle={t('settingsVoice.systemPromptSubtitle')}
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color="#34C759" />}
                    detail={systemPromptPreview}
                    onPress={() => router.push('/settings/voice/system-prompt')}
                />
            </ItemGroup>

        </ItemList>
    );
}