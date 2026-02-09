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
import { getElevenLabsAgentId, setElevenLabsAgentId, hasCustomElevenLabsAgentId } from '@/sync/voiceConfig';
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
}));

export default function ElevenLabsConfigScreen() {
    const router = useRouter();
    const styles = stylesheet;
    const isCustom = hasCustomElevenLabsAgentId();
    const [inputValue, setInputValue] = useState(isCustom ? (getElevenLabsAgentId() ?? '') : '');

    const handleSave = () => {
        setElevenLabsAgentId(inputValue.trim() || null);
        router.back();
    };

    const handleReset = () => {
        setElevenLabsAgentId(null);
        setInputValue('');
    };

    return (
        <KeyboardAvoidingView
            style={styles.keyboardAvoidingView}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ItemList style={{ flex: 1 }}>
                <ItemGroup footer={t('settingsVoice.elevenLabsDescription')}>
                    <View style={styles.contentContainer}>
                        <Text style={styles.labelText}>{t('settingsVoice.agentId')}</Text>
                        <TextInput
                            style={styles.textInput}
                            value={inputValue}
                            onChangeText={setInputValue}
                            placeholder={t('settingsVoice.agentIdPlaceholder')}
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
                        {isCustom && (
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
