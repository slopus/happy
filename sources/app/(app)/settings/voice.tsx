import React, { useState, useCallback, memo } from 'react';
import { View, TextInput, ActivityIndicator, Pressable, Linking } from 'react-native';
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
import { findHappyAgent, createOrUpdateHappyAgent } from '@/sync/apiVoice';

function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [useCustomAgent, setUseCustomAgent] = useSettingMutable('elevenLabsUseCustomAgent');
    const [savedAgentId, setSavedAgentId] = useSettingMutable('elevenLabsAgentId');
    const [savedApiKey, setSavedApiKey] = useSettingMutable('elevenLabsApiKey');

    // Local state for input fields
    const [agentIdInput, setAgentIdInput] = useState(savedAgentId || '');
    const [apiKeyInput, setApiKeyInput] = useState(savedApiKey || '');

    // Loading states for buttons
    const [findingAgent, setFindingAgent] = useState(false);
    const [creatingAgent, setCreatingAgent] = useState(false);

    // Show/hide API key
    const [showApiKey, setShowApiKey] = useState(false);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleToggleCustomAgent = useCallback((value: boolean) => {
        setUseCustomAgent(value);
    }, [setUseCustomAgent]);

    // Save API key when user leaves the field
    const handleApiKeyBlur = useCallback(() => {
        if (apiKeyInput.trim() && apiKeyInput.trim() !== savedApiKey) {
            setSavedApiKey(apiKeyInput.trim());
        }
    }, [apiKeyInput, savedApiKey, setSavedApiKey]);

    // Save Agent ID when user leaves the field
    const handleAgentIdBlur = useCallback(() => {
        if (agentIdInput.trim() && agentIdInput.trim() !== savedAgentId) {
            setSavedAgentId(agentIdInput.trim());
        }
    }, [agentIdInput, savedAgentId, setSavedAgentId]);

    // Save credentials manually
    const handleSaveCredentials = useCallback(() => {
        if (!apiKeyInput.trim()) {
            Modal.alert(t('common.error'), t('settingsVoice.apiKeyRequired'));
            return;
        }
        if (!agentIdInput.trim()) {
            Modal.alert(t('common.error'), t('settingsVoice.agentIdRequired'));
            return;
        }

        storage.getState().applySettingsLocal({
            elevenLabsApiKey: apiKeyInput.trim(),
            elevenLabsAgentId: agentIdInput.trim(),
        });

        Modal.alert(t('common.success'), t('settingsVoice.credentialsSaved'));
    }, [apiKeyInput, agentIdInput]);

    // Find existing agent by name
    const handleFindAgent = useCallback(async () => {
        if (!apiKeyInput.trim()) {
            Modal.alert(t('common.error'), t('settingsVoice.apiKeyRequired'));
            return;
        }

        setFindingAgent(true);
        try {
            const result = await findHappyAgent(apiKeyInput.trim());

            if (result.success && result.agentId) {
                setAgentIdInput(result.agentId);
                // Save both API key and agent ID
                storage.getState().applySettingsLocal({
                    elevenLabsApiKey: apiKeyInput.trim(),
                    elevenLabsAgentId: result.agentId,
                });
                Modal.alert(t('common.success'), t('settingsVoice.agentFound'));
            } else {
                Modal.alert(t('common.error'), result.error || t('settingsVoice.agentNotFound'));
            }
        } finally {
            setFindingAgent(false);
        }
    }, [apiKeyInput]);

    // Create or update agent with default configuration
    const handleCreateOrUpdateAgent = useCallback(async () => {
        if (!apiKeyInput.trim()) {
            Modal.alert(t('common.error'), t('settingsVoice.apiKeyRequired'));
            return;
        }

        setCreatingAgent(true);
        try {
            const result = await createOrUpdateHappyAgent(apiKeyInput.trim());

            if (result.success && result.agentId) {
                setAgentIdInput(result.agentId);
                // Save both API key and agent ID
                storage.getState().applySettingsLocal({
                    elevenLabsApiKey: apiKeyInput.trim(),
                    elevenLabsAgentId: result.agentId,
                });

                const message = result.created
                    ? t('settingsVoice.agentCreated')
                    : t('settingsVoice.agentUpdated');
                Modal.alert(t('common.success'), message);
            } else {
                Modal.alert(t('common.error'), result.error || t('settingsVoice.agentCreateFailed'));
            }
        } finally {
            setCreatingAgent(false);
        }
    }, [apiKeyInput]);

    const getAgentStatusText = () => {
        if (!useCustomAgent) {
            return t('settingsVoice.usingDefaultAgent');
        }
        if (savedAgentId) {
            return t('settingsVoice.usingCustomAgent');
        }
        return t('settingsVoice.credentialsRequired');
    };

    const isLoading = findingAgent || creatingAgent;

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
                <ItemGroup
                    title={t('settingsVoice.customAgentCredentials')}
                    footer={t('settingsVoice.customAgentCredentialsDescription')}
                >
                    <View style={styles.contentContainer}>
                        {/* API Key first */}
                        <View style={styles.labelRow}>
                            <Text style={styles.labelText}>{t('settingsVoice.apiKey').toUpperCase()}</Text>
                            <Pressable
                                onPress={() => Linking.openURL('https://elevenlabs.io/app/settings/api-keys')}
                                style={styles.helpButton}
                            >
                                <Ionicons name="help-circle-outline" size={18} color={theme.colors.textLink} />
                                <Text style={[styles.helpText, { color: theme.colors.textLink }]}>{t('settingsVoice.getApiKey')}</Text>
                            </Pressable>
                        </View>
                        <View style={styles.inputWithButton}>
                            <TextInput
                                style={[styles.textInputFlex, { color: theme.colors.input.text, backgroundColor: theme.colors.input.background }]}
                                value={apiKeyInput}
                                onChangeText={setApiKeyInput}
                                onBlur={handleApiKeyBlur}
                                placeholder={t('settingsVoice.apiKeyPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry={!showApiKey}
                            />
                            <Pressable
                                style={[styles.showHideButton, { backgroundColor: theme.colors.input.background }]}
                                onPress={() => setShowApiKey(!showApiKey)}
                            >
                                <Ionicons
                                    name={showApiKey ? 'eye-off-outline' : 'eye-outline'}
                                    size={20}
                                    color={theme.colors.textSecondary}
                                />
                            </Pressable>
                        </View>

                        {/* Agent ID second, with buttons */}
                        <Text style={styles.labelText}>{t('settingsVoice.agentId').toUpperCase()}</Text>
                        <TextInput
                            style={[styles.textInput, { color: theme.colors.input.text, backgroundColor: theme.colors.input.background }]}
                            value={agentIdInput}
                            onChangeText={setAgentIdInput}
                            onBlur={handleAgentIdBlur}
                            placeholder={t('settingsVoice.agentIdPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        {/* Buttons for Find Agent and Create/Update Agent */}
                        <View style={styles.buttonRow}>
                            <View style={styles.buttonWrapper}>
                                <RoundButton
                                    title={findingAgent ? '' : t('settingsVoice.findAgent')}
                                    size="normal"
                                    display="inverted"
                                    action={handleFindAgent}
                                    disabled={isLoading}
                                />
                                {findingAgent && (
                                    <View style={styles.loadingOverlay}>
                                        <ActivityIndicator size="small" color={theme.colors.text} />
                                    </View>
                                )}
                            </View>
                            <View style={styles.buttonWrapper}>
                                <RoundButton
                                    title={creatingAgent ? '' : t('settingsVoice.createOrUpdateAgent')}
                                    size="normal"
                                    action={handleCreateOrUpdateAgent}
                                    disabled={isLoading}
                                />
                                {creatingAgent && (
                                    <View style={styles.loadingOverlay}>
                                        <ActivityIndicator size="small" color={theme.colors.surface} />
                                    </View>
                                )}
                            </View>
                        </View>

                        <Text style={styles.hintText}>{t('settingsVoice.agentButtonsHint')}</Text>

                        {/* Save Credentials Button */}
                        <View style={styles.saveButtonContainer}>
                            <RoundButton
                                title={t('settingsVoice.saveCredentials')}
                                size="normal"
                                onPress={handleSaveCredentials}
                                disabled={isLoading}
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
    labelRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 8,
        marginBottom: 8,
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    helpButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    helpText: {
        ...Typography.default(),
        fontSize: 12,
    },
    textInput: {
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
    },
    inputWithButton: {
        flexDirection: 'row',
        marginBottom: 8,
        gap: 8,
    },
    textInputFlex: {
        flex: 1,
        padding: 12,
        borderRadius: 8,
        ...Typography.mono(),
        fontSize: 14,
    },
    showHideButton: {
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 12,
        borderRadius: 8,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 12,
    },
    buttonWrapper: {
        flex: 1,
        position: 'relative',
    },
    loadingOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },
    hintText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 12,
        lineHeight: 16,
    },
    saveButtonContainer: {
        marginTop: 16,
    },
}));
