import { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { layout } from '@/components/layout';
import { t } from '@/text';
import {
    getHappyVoiceGatewayUrl,
    setHappyVoiceGatewayUrl,
    getHappyVoicePublicKey,
    setHappyVoicePublicKey,
    hasCustomHappyVoiceGatewayUrl,
    hasCustomHappyVoicePublicKey,
    validateUrl,
} from '@/sync/voiceConfig';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: { flex: 1 },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase' as const,
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 8,
    },
    buttonRow: {
        flexDirection: 'row' as const,
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: { flex: 1 },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center' as const,
    },
    spacer: { height: 16 },
}));

export default function HappyVoiceConfigScreen() {
    const router = useRouter();
    const styles = stylesheet;
    const isCustomUrl = hasCustomHappyVoiceGatewayUrl();
    const isCustomKey = hasCustomHappyVoicePublicKey();

    const [urlInput, setUrlInput] = useState(isCustomUrl ? (getHappyVoiceGatewayUrl() ?? '') : '');
    const [keyInput, setKeyInput] = useState(isCustomKey ? (getHappyVoicePublicKey() ?? '') : '');
    const [urlError, setUrlError] = useState<string | null>(null);

    const handleSave = () => {
        // Validate URL if provided
        if (urlInput.trim()) {
            const validation = validateUrl(urlInput.trim());
            if (!validation.valid) {
                setUrlError(validation.error || t('settingsVoice.invalidUrl'));
                return;
            }
        }

        setHappyVoiceGatewayUrl(urlInput.trim() || null);
        setHappyVoicePublicKey(keyInput.trim() || null);
        router.back();
    };

    const handleReset = () => {
        setHappyVoiceGatewayUrl(null);
        setHappyVoicePublicKey(null);
        setUrlInput('');
        setKeyInput('');
        setUrlError(null);
    };

    return (
        <KeyboardAvoidingView
            style={styles.keyboardAvoidingView}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ItemList style={{ flex: 1 }}>
                <ItemGroup footer={t('settingsVoice.happyVoiceDescription')}>
                    <View style={styles.contentContainer}>
                        {/* Gateway URL */}
                        <Text style={styles.labelText}>{t('settingsVoice.gatewayUrl')}</Text>
                        <TextInput
                            style={styles.textInput}
                            value={urlInput}
                            onChangeText={(text) => {
                                setUrlInput(text);
                                setUrlError(null);
                            }}
                            placeholder={t('settingsVoice.gatewayUrlPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                        />
                        {urlError && <Text style={styles.errorText}>{urlError}</Text>}

                        <View style={styles.spacer} />

                        {/* Public Key */}
                        <Text style={styles.labelText}>{t('settingsVoice.publicKey')}</Text>
                        <TextInput
                            style={styles.textInput}
                            value={keyInput}
                            onChangeText={setKeyInput}
                            placeholder={t('settingsVoice.publicKeyPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <View style={styles.buttonRow}>
                            <View style={styles.buttonWrapper}>
                                <RoundButton
                                    title={t('settingsVoice.resetToDefault')}
                                    size="normal"
                                    display="inverted"
                                    onPress={handleReset}
                                />
                            </View>
                            <View style={styles.buttonWrapper}>
                                <RoundButton
                                    title={t('common.save')}
                                    size="normal"
                                    onPress={handleSave}
                                />
                            </View>
                        </View>
                        {(isCustomUrl || isCustomKey) && (
                            <Text style={styles.statusText}>
                                {t('settingsVoice.usingCustomConfig')}
                            </Text>
                        )}
                    </View>
                </ItemGroup>
            </ItemList>
        </KeyboardAvoidingView>
    );
}
