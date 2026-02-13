import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import { Switch } from 'react-native';
import { WHISPER_MODELS } from '@/speechToText/config';

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');

    // STT settings
    const [sttEnabled, setSttEnabled] = useSettingMutable('sttEnabled');
    const sttLocalModel = useSetting('sttLocalModel');

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    // Get model display name
    const modelInfo = WHISPER_MODELS[sttLocalModel];
    const modelDisplayName = modelInfo ? `${modelInfo.displayName} (~${Math.round(modelInfo.fileSize / 1024 / 1024)}MB)` : sttLocalModel;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Assistant Language Settings */}
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

            {/* Speech-to-Text Settings */}
            <ItemGroup
                title={t('settingsSTT.title') || 'Speech to Text'}
                footer={t('settingsSTT.description') || 'Convert speech to text for voice input in the chat'}
            >
                <Item
                    title={t('settingsSTT.enable') || 'Enable Voice Input'}
                    subtitle={t('settingsSTT.enableDescription') || 'Use microphone button for speech-to-text'}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    rightElement={
                        <Switch
                            value={sttEnabled}
                            onValueChange={setSttEnabled}
                            trackColor={{ false: theme.colors.switchTrackOff, true: theme.colors.switchTrackOn }}
                            thumbColor={theme.colors.switchThumb}
                        />
                    }
                />

                {sttEnabled && (
                    <Item
                        title={t('settingsSTT.model') || 'Whisper Model'}
                        subtitle={t('settingsSTT.modelDescription') || 'Larger models are more accurate but slower'}
                        icon={<Ionicons name="cube-outline" size={29} color="#FF9500" />}
                        detail={modelDisplayName}
                        onPress={() => router.push('/settings/voice/stt')}
                    />
                )}
            </ItemGroup>

        </ItemList>
    );
}