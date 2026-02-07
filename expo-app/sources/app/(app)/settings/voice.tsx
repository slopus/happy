import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceAssistantSystemPrompt] = useSettingMutable('voiceAssistantSystemPrompt');

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    // Get system prompt preview (truncated)
    const systemPromptPreview = voiceAssistantSystemPrompt
        ? (voiceAssistantSystemPrompt.length > 30
            ? voiceAssistantSystemPrompt.substring(0, 30) + '...'
            : voiceAssistantSystemPrompt)
        : t('settingsVoice.systemPromptDefault');

    return (
        <ItemList style={{ paddingTop: 0 }}>
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