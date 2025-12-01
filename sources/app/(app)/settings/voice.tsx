import React, { useState, useCallback, memo } from 'react';
import { View, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { RoundButton } from '@/components/RoundButton';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { useSettingMutable, storage } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';

function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [useCustomAgent, setUseCustomAgent] = useSettingMutable('elevenLabsUseCustomAgent');
    const [savedAgentId] = useSettingMutable('elevenLabsAgentId');
    const [savedApiKey] = useSettingMutable('elevenLabsApiKey');

    // Local state for input fields
    const [agentIdInput, setAgentIdInput] = useState(savedAgentId || '');
    const [apiKeyInput, setApiKeyInput] = useState(savedApiKey || '');

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleToggleCustomAgent = useCallback((value: boolean) => {
        setUseCustomAgent(value);
    }, [setUseCustomAgent]);

    const handleSaveCredentials = useCallback(async () => {
        if (!agentIdInput.trim() || !apiKeyInput.trim()) {
            Modal.alert(t('common.error'), t('settingsVoice.credentialsRequired'));
            return;
        }

        // Save to settings (synced across devices)
        storage.getState().applySettingsLocal({
            elevenLabsAgentId: agentIdInput.trim(),
            elevenLabsApiKey: apiKeyInput.trim(),
        });

        Modal.alert(t('common.success'), t('settingsVoice.credentialsSaved'));
    }, [agentIdInput, apiKeyInput]);

    const getAgentStatusText = () => {
        if (!useCustomAgent) {
            return t('settingsVoice.usingDefaultAgent');
        }
        if (savedAgentId) {
            return t('settingsVoice.usingCustomAgent');
        }
        return t('settingsVoice.credentialsRequired');
    };

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

            {/* ElevenLabs Configuration */}
            <ItemGroup
                title={t('settingsVoice.elevenLabsTitle')}
                footer={t('settingsVoice.elevenLabsDescription')}
            >
                <Item
                    title={t('settingsVoice.useCustomAgent')}
                    subtitle={t('settingsVoice.useCustomAgentSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#FF6B35" />}
                    showChevron={false}
                    rightElement={
                        <Switch
                            value={useCustomAgent}
                            onValueChange={handleToggleCustomAgent}
                        />
                    }
                />
                <Item
                    title={t('settingsVoice.currentAgentId')}
                    subtitle={getAgentStatusText()}
                    detail={useCustomAgent && savedAgentId ? savedAgentId.slice(0, 20) + '...' : undefined}
                    showChevron={false}
                    copy={useCustomAgent && savedAgentId ? savedAgentId : undefined}
                />
            </ItemGroup>

            {/* Custom Agent Credentials - only show when custom agent is enabled */}
            {useCustomAgent && (
                <ItemGroup title={t('settingsVoice.agentId')}>
                    <View style={styles.contentContainer}>
                        <Text style={styles.labelText}>{t('settingsVoice.agentId').toUpperCase()}</Text>
                        <TextInput
                            style={[styles.textInput, { color: theme.colors.input.text, backgroundColor: theme.colors.input.background }]}
                            value={agentIdInput}
                            onChangeText={setAgentIdInput}
                            placeholder={t('settingsVoice.agentIdPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <Text style={styles.labelText}>{t('settingsVoice.apiKey').toUpperCase()}</Text>
                        <TextInput
                            style={[styles.textInput, { color: theme.colors.input.text, backgroundColor: theme.colors.input.background }]}
                            value={apiKeyInput}
                            onChangeText={setApiKeyInput}
                            placeholder={t('settingsVoice.apiKeyPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry={true}
                        />

                        <View style={styles.buttonContainer}>
                            <RoundButton
                                title={t('settingsVoice.saveCredentials')}
                                size="normal"
                                action={handleSaveCredentials}
                            />
                        </View>
                    </View>
                </ItemGroup>
            )}

        </ItemList>
    );
}

export default memo(VoiceSettingsScreen);

const styles = StyleSheet.create((theme) => ({
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
        marginTop: 8,
    },
    textInput: {
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
    },
    buttonContainer: {
        marginTop: 12,
    },
}));
