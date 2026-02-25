import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import { getWhisperUrl, setWhisperUrl } from '@/sync/serverConfig';

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceMode, setVoiceMode] = useSettingMutable('voiceMode');
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];
    const isDictation = voiceMode === 'dictation';

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Mode Selection */}
            <ItemGroup
                title={t('settingsVoice.modeTitle')}
                footer={t('settingsVoice.modeDescription')}
            >
                <Item
                    title={t('settingsVoice.assistantMode')}
                    subtitle={t('settingsVoice.assistantModeSubtitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#007AFF" />}
                    rightElement={!isDictation ? <Ionicons name="checkmark" size={22} color="#007AFF" /> : null}
                    onPress={() => setVoiceMode('assistant')}
                    showChevron={false}
                />
                <Item
                    title={t('settingsVoice.dictationMode')}
                    subtitle={t('settingsVoice.dictationModeSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    rightElement={isDictation ? <Ionicons name="checkmark" size={22} color="#007AFF" /> : null}
                    onPress={() => setVoiceMode('dictation')}
                    showChevron={false}
                />
            </ItemGroup>

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

            {/* Whisper URL (only when dictation mode is selected) */}
            {isDictation && (
                <ItemGroup
                    title={t('settingsVoice.whisperTitle')}
                    footer={t('settingsVoice.whisperDescription')}
                >
                    <WhisperUrlInput />
                </ItemGroup>
            )}
        </ItemList>
    );
}

function WhisperUrlInput() {
    const { theme } = useUnistyles();
    const [url, setUrl] = useState(getWhisperUrl());
    const [saved, setSaved] = useState(false);

    const handleSave = () => {
        setWhisperUrl(url.trim() || null);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    const handleReset = () => {
        setWhisperUrl(null);
        setUrl(getWhisperUrl());
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    return (
        <View style={{ padding: 12 }}>
            <Text style={{
                ...Typography.default('semiBold'),
                fontSize: 12,
                color: theme.colors.textSecondary,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 8,
            }}>
                {t('settingsVoice.whisperUrlLabel')}
            </Text>
            <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder={t('settingsVoice.whisperUrlPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={{
                    backgroundColor: theme.colors.input.background,
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 8,
                    ...Typography.mono(),
                    fontSize: 14,
                    color: theme.colors.input.text,
                }}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                    <RoundButton
                        title={saved ? t('settingsVoice.whisperUrlSaved') : t('settingsVoice.whisperUrlSave')}
                        onPress={handleSave}
                    />
                </View>
                <View style={{ flex: 1 }}>
                    <RoundButton
                        title={t('settingsVoice.whisperUrlReset')}
                        onPress={handleReset}
                    />
                </View>
            </View>
        </View>
    );
}
