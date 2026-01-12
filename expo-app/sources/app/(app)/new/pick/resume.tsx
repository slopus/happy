import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { MultiTextInput } from '@/components/MultiTextInput';
import * as Clipboard from 'expo-clipboard';
import { AgentType } from '@/utils/agentCapabilities';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    inputSection: {
        padding: 16,
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    inputLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    inputContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 16,
    },
    button: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surface,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: theme.colors.button.primary.tint,
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    clearButton: {
        marginTop: 12,
        paddingVertical: 12,
        alignItems: 'center',
    },
    clearButtonText: {
        fontSize: 15,
        color: theme.colors.textDestructive,
        ...Typography.default('semiBold'),
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 12,
        lineHeight: 20,
        ...Typography.default(),
    },
}));

export default function ResumePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        currentResumeId?: string;
        agentType?: AgentType;
    }>();

    const [inputValue, setInputValue] = React.useState(params.currentResumeId || '');
    const agentType: AgentType = params.agentType || 'claude';
    const agentLabel = agentType === 'codex'
        ? t('agentInput.agent.codex')
        : agentType === 'gemini'
            ? t('agentInput.agent.gemini')
            : t('agentInput.agent.claude');

    const handleSave = () => {
        const trimmed = inputValue.trim();
        const state = navigation.getState();
        if (!state) {
            router.back();
            return;
        }
        const previousRoute = state.routes[state.index - 1];
        if (previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ resumeSessionId: trimmed }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    };

    const handleClear = () => {
        const state = navigation.getState();
        if (!state) {
            router.back();
            return;
        }
        const previousRoute = state.routes[state.index - 1];
        if (previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ resumeSessionId: '' }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    };

    const handlePaste = async () => {
        const text = (await Clipboard.getStringAsync()).trim();
        if (text) {
            setInputValue(text);
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('newSession.resume.pickerTitle'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <View style={styles.container}>
                <ItemList>
                    <ItemGroup>
                        <View style={styles.inputSection}>
                            <Text style={styles.inputLabel}>
                                {t('newSession.resume.subtitle', { agent: agentLabel })}
                            </Text>

                            <View style={styles.inputContainer}>
                                <MultiTextInput
                                    value={inputValue}
                                    onChangeText={setInputValue}
                                    placeholder={
                                        t('newSession.resume.placeholder', { agent: agentLabel })
                                    }
                                    maxHeight={80}
                                    paddingTop={0}
                                    paddingBottom={0}
                                />
                            </View>

                            <View style={styles.buttonRow}>
                                <Pressable
                                    onPress={handlePaste}
                                    style={({ pressed }) => [
                                        styles.button,
                                        styles.buttonSecondary,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Ionicons name="clipboard-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                                            {t('newSession.resume.paste')}
                                        </Text>
                                    </View>
                                </Pressable>
                                <Pressable
                                    onPress={handleSave}
                                    style={({ pressed }) => [
                                        styles.button,
                                        styles.buttonPrimary,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                                        {t('newSession.resume.save')}
                                    </Text>
                                </Pressable>
                            </View>

                            {inputValue.trim() && (
                                <Pressable
                                    onPress={handleClear}
                                    style={({ pressed }) => [
                                        styles.clearButton,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <Text style={styles.clearButtonText}>
                                        {t('newSession.resume.clearAndRemove')}
                                    </Text>
                                </Pressable>
                            )}

                            <Text style={styles.helpText}>
                                {t('newSession.resume.helpText')}
                            </Text>
                        </View>
                    </ItemGroup>
                </ItemList>
            </View>
        </>
    );
}

