import React, { memo, useState, useCallback } from 'react';
import { View, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, storage } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { STEPFUN_CONSTANTS } from '@/realtime/stepfun/constants';

type VoiceProviderType = 'stepfun' | 'elevenlabs' | 'none';
type ASRProviderType = 'stepfun' | 'none';

const PROVIDERS: { type: VoiceProviderType; name: string; description: string; icon: string; color: string }[] = [
    {
        type: 'stepfun',
        name: 'StepFun',
        description: 'StepFun Realtime Voice API',
        icon: 'flash-outline',
        color: '#FF9500',
    },
    {
        type: 'elevenlabs',
        name: 'ElevenLabs',
        description: 'ElevenLabs Conversational AI',
        icon: 'volume-high-outline',
        color: '#007AFF',
    },
    {
        type: 'none',
        name: 'None',
        description: 'Disable voice assistant',
        icon: 'close-circle-outline',
        color: '#8E8E93',
    },
];

const STEPFUN_VOICES = [
    { id: STEPFUN_CONSTANTS.VOICES.QINGCHUN_SHAONV, name: '青春少女 (Young Female)' },
    { id: STEPFUN_CONSTANTS.VOICES.WENROU_NANSHENG, name: '温柔男声 (Gentle Male)' },
    { id: STEPFUN_CONSTANTS.VOICES.ELEGANT_GENTLE_FEMALE, name: '优雅女声 (Elegant Female)' },
    { id: STEPFUN_CONSTANTS.VOICES.LIVELY_BREEZY_FEMALE, name: '活泼女声 (Lively Female)' },
];

const STEPFUN_MODELS = [
    { id: 'step-audio-2', name: 'step-audio-2' },
];

const ASR_PROVIDERS: { type: ASRProviderType; name: string; description: string; icon: string; color: string }[] = [
    {
        type: 'stepfun',
        name: 'StepFun ASR',
        description: 'StepFun Speech-to-Text (step-asr)',
        icon: 'mic-outline',
        color: '#FF9500',
    },
    {
        type: 'none',
        name: 'None',
        description: 'Disable voice input',
        icon: 'close-circle-outline',
        color: '#8E8E93',
    },
];

export default memo(function VoiceProviderScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceProvider, setVoiceProvider] = useSettingMutable('voiceProvider');
    const [stepFunConfig, setStepFunConfig] = useSettingMutable('voiceProviderStepFun');
    const [elevenLabsConfig, setElevenLabsConfig] = useSettingMutable('voiceProviderElevenLabs');
    const [asrProvider, setAsrProvider] = useSettingMutable('asrProvider');

    // Local state for form inputs
    const [apiKey, setApiKey] = useState(stepFunConfig?.apiKey || '');
    const [modelId, setModelId] = useState(stepFunConfig?.modelId || STEPFUN_CONSTANTS.DEFAULT_MODEL);
    const [voice, setVoice] = useState(stepFunConfig?.voice || STEPFUN_CONSTANTS.DEFAULT_VOICE);
    const [elevenLabsAgentIdDev, setElevenLabsAgentIdDev] = useState(elevenLabsConfig?.agentIdDev || '');
    const [elevenLabsAgentIdProd, setElevenLabsAgentIdProd] = useState(elevenLabsConfig?.agentIdProd || '');

    const [showVoiceSelector, setShowVoiceSelector] = useState(false);
    const [showModelSelector, setShowModelSelector] = useState(false);

    const handleProviderSelect = useCallback((type: VoiceProviderType) => {
        setVoiceProvider(type);
    }, [setVoiceProvider]);

    const handleASRProviderSelect = useCallback((type: ASRProviderType) => {
        setAsrProvider(type);
    }, [setAsrProvider]);

    const handleSaveStepFunConfig = useCallback(() => {
        setStepFunConfig({
            apiKey: apiKey.trim() || undefined,
            modelId: modelId || undefined,
            voice: voice || undefined,
        });
    }, [apiKey, modelId, voice, setStepFunConfig]);

    const handleSaveElevenLabsConfig = useCallback(() => {
        setElevenLabsConfig({
            agentIdDev: elevenLabsAgentIdDev.trim() || undefined,
            agentIdProd: elevenLabsAgentIdProd.trim() || undefined,
        });
    }, [elevenLabsAgentIdDev, elevenLabsAgentIdProd, setElevenLabsConfig]);

    const handleVoiceSelect = useCallback((voiceId: string) => {
        setVoice(voiceId);
        setShowVoiceSelector(false);
        // Auto-save when voice is selected
        setStepFunConfig({
            apiKey: apiKey.trim() || undefined,
            modelId: modelId || undefined,
            voice: voiceId || undefined,
        });
    }, [apiKey, modelId, setStepFunConfig]);

    const handleModelSelect = useCallback((model: string) => {
        setModelId(model);
        setShowModelSelector(false);
        // Auto-save when model is selected
        setStepFunConfig({
            apiKey: apiKey.trim() || undefined,
            modelId: model || undefined,
            voice: voice || undefined,
        });
    }, [apiKey, voice, setStepFunConfig]);

    const selectedVoice = STEPFUN_VOICES.find(v => v.id === voice);
    const selectedModel = STEPFUN_MODELS.find(m => m.id === modelId);

    return (
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ItemList style={{ paddingTop: 0 }}>
                {/* Provider Selection */}
                <ItemGroup
                    title={t('settingsVoice.provider.selectTitle')}
                    footer={t('settingsVoice.provider.selectDescription')}
                >
                    {PROVIDERS.map((provider) => (
                        <Item
                            key={provider.type}
                            title={provider.name}
                            subtitle={provider.description}
                            icon={<Ionicons name={provider.icon as any} size={29} color={provider.color} />}
                            rightElement={
                                voiceProvider === provider.type ? (
                                    <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                ) : null
                            }
                            onPress={() => handleProviderSelect(provider.type)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>

                {/* StepFun Configuration */}
                {voiceProvider === 'stepfun' && (
                    <ItemGroup
                        title={t('settingsVoice.provider.stepfunConfig')}
                        footer={t('settingsVoice.provider.stepfunConfigDescription')}
                    >
                        {/* API Key Input */}
                        <View style={styles.inputContainer}>
                            <View style={styles.inputLabelRow}>
                                <Ionicons name="key-outline" size={20} color={theme.colors.textSecondary} />
                                <View style={styles.inputLabel}>
                                    <TextInput
                                        style={[styles.input, { color: theme.colors.text }]}
                                        placeholder={t('settingsVoice.provider.apiKeyPlaceholder')}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={apiKey}
                                        onChangeText={setApiKey}
                                        onBlur={handleSaveStepFunConfig}
                                        secureTextEntry
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </View>
                            </View>
                        </View>

                        {/* Model Selection */}
                        {showModelSelector ? (
                            <>
                                {STEPFUN_MODELS.map((model) => (
                                    <Item
                                        key={model.id}
                                        title={model.name}
                                        icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />}
                                        rightElement={
                                            modelId === model.id ? (
                                                <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                            ) : null
                                        }
                                        onPress={() => handleModelSelect(model.id)}
                                        showChevron={false}
                                    />
                                ))}
                            </>
                        ) : (
                            <Item
                                title={t('settingsVoice.provider.model')}
                                subtitle={selectedModel?.name || modelId}
                                icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />}
                                onPress={() => setShowModelSelector(true)}
                            />
                        )}

                        {/* Voice Selection */}
                        {showVoiceSelector ? (
                            <>
                                {STEPFUN_VOICES.map((v) => (
                                    <Item
                                        key={v.id}
                                        title={v.name}
                                        icon={<Ionicons name="person-outline" size={29} color="#FF2D55" />}
                                        rightElement={
                                            voice === v.id ? (
                                                <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                            ) : null
                                        }
                                        onPress={() => handleVoiceSelect(v.id)}
                                        showChevron={false}
                                    />
                                ))}
                            </>
                        ) : (
                            <Item
                                title={t('settingsVoice.provider.voice')}
                                subtitle={selectedVoice?.name || voice}
                                icon={<Ionicons name="person-outline" size={29} color="#FF2D55" />}
                                onPress={() => setShowVoiceSelector(true)}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* ElevenLabs Configuration */}
                {voiceProvider === 'elevenlabs' && (
                    <ItemGroup
                        title={t('settingsVoice.provider.elevenLabsConfig')}
                        footer={t('settingsVoice.provider.elevenLabsConfigDescription')}
                    >
                        {/* Agent ID Dev */}
                        <View style={styles.inputContainer}>
                            <View style={styles.inputLabelRow}>
                                <Ionicons name="construct-outline" size={20} color={theme.colors.textSecondary} />
                                <View style={styles.inputLabel}>
                                    <TextInput
                                        style={[styles.input, { color: theme.colors.text }]}
                                        placeholder={t('settingsVoice.provider.agentIdDevPlaceholder')}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={elevenLabsAgentIdDev}
                                        onChangeText={setElevenLabsAgentIdDev}
                                        onBlur={handleSaveElevenLabsConfig}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </View>
                            </View>
                        </View>

                        {/* Agent ID Prod */}
                        <View style={styles.inputContainer}>
                            <View style={styles.inputLabelRow}>
                                <Ionicons name="rocket-outline" size={20} color={theme.colors.textSecondary} />
                                <View style={styles.inputLabel}>
                                    <TextInput
                                        style={[styles.input, { color: theme.colors.text }]}
                                        placeholder={t('settingsVoice.provider.agentIdProdPlaceholder')}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={elevenLabsAgentIdProd}
                                        onChangeText={setElevenLabsAgentIdProd}
                                        onBlur={handleSaveElevenLabsConfig}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </View>
                            </View>
                        </View>
                    </ItemGroup>
                )}

                {/* ASR Provider Selection */}
                <ItemGroup
                    title={t('settingsVoice.asr.title') || 'Voice Input (ASR)'}
                    footer={t('settingsVoice.asr.description') || 'Speech-to-text for voice input mode'}
                >
                    {ASR_PROVIDERS.map((provider) => (
                        <Item
                            key={provider.type}
                            title={provider.name}
                            subtitle={provider.description}
                            icon={<Ionicons name={provider.icon as any} size={29} color={provider.color} />}
                            rightElement={
                                asrProvider === provider.type ? (
                                    <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                ) : null
                            }
                            onPress={() => handleASRProviderSelect(provider.type)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>

                {/* ASR uses same API key as voice provider when StepFun is selected */}
                {asrProvider === 'stepfun' && !stepFunConfig?.apiKey && (
                    <ItemGroup
                        title=""
                        footer={t('settingsVoice.asr.apiKeyNote') || 'Note: StepFun ASR uses the same API key as the voice provider above. Please configure it in the StepFun section.'}
                    >
                    </ItemGroup>
                )}
            </ItemList>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    inputLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    inputLabel: {
        flex: 1,
    },
    input: {
        fontSize: 16,
        padding: 0,
    },
}));
