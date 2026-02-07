import React, { useState } from 'react';
import { View, TextInput, Text, Pressable, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful voice assistant integrated with Claude Code, an AI coding assistant. Your role is to help users interact with their coding sessions through voice.

You can:
1. Send messages to Claude Code on behalf of the user using the messageClaudeCode tool
2. Approve or deny permission requests from Claude Code using the processPermissionRequest tool

Guidelines:
- Be concise and conversational in your responses
- When the user wants to give instructions to Claude Code, use the messageClaudeCode tool
- When Claude Code requests permission for an action, clearly explain what it wants to do and ask for user confirmation before using processPermissionRequest
- Always confirm actions you've taken
- If you're unsure what the user wants, ask for clarification`;

export default function SystemPromptScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const [voiceAssistantSystemPrompt, setVoiceAssistantSystemPrompt] = useSettingMutable('voiceAssistantSystemPrompt');
    const [text, setText] = useState(voiceAssistantSystemPrompt || '');

    const handleSave = () => {
        setVoiceAssistantSystemPrompt(text.trim() || null);
        router.back();
    };

    const handleReset = () => {
        setText('');
    };

    const handleUseDefault = () => {
        setText(DEFAULT_SYSTEM_PROMPT);
    };

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16 }}
                keyboardShouldPersistTaps="handled"
            >
                {/* Description */}
                <Text style={styles.description}>
                    {t('settingsVoice.systemPromptEdit.description')}
                </Text>

                {/* Text Input */}
                <TextInput
                    style={[
                        styles.textInput,
                        {
                            backgroundColor: theme.colors.input.background,
                            color: theme.colors.input.text,
                            borderColor: theme.colors.divider,
                        }
                    ]}
                    placeholder={t('settingsVoice.systemPromptEdit.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={text}
                    onChangeText={setText}
                    multiline
                    textAlignVertical="top"
                    autoCapitalize="sentences"
                    autoCorrect={true}
                />

                {/* Action Buttons */}
                <View style={styles.buttonContainer}>
                    <Pressable
                        style={[styles.button, styles.secondaryButton, { borderColor: theme.colors.divider }]}
                        onPress={handleReset}
                    >
                        <Ionicons name="trash-outline" size={18} color={theme.colors.text} />
                        <Text style={[styles.buttonText, { color: theme.colors.text }]}>
                            {t('settingsVoice.systemPromptEdit.reset')}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={[styles.button, styles.secondaryButton, { borderColor: theme.colors.divider }]}
                        onPress={handleUseDefault}
                    >
                        <Ionicons name="refresh-outline" size={18} color={theme.colors.text} />
                        <Text style={[styles.buttonText, { color: theme.colors.text }]}>
                            {t('settingsVoice.systemPromptEdit.useDefault')}
                        </Text>
                    </Pressable>
                </View>

                {/* Hint */}
                <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                    {t('settingsVoice.systemPromptEdit.hint')}
                </Text>
            </ScrollView>

            {/* Save Button */}
            <View style={[styles.saveContainer, { paddingBottom: insets.bottom + 16, backgroundColor: theme.colors.surface }]}>
                <Pressable
                    style={[styles.saveButton, { backgroundColor: '#007AFF' }]}
                    onPress={handleSave}
                >
                    <Text style={styles.saveButtonText}>
                        {t('common.save')}
                    </Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create((theme) => ({
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 20,
    },
    textInput: {
        minHeight: 200,
        maxHeight: 400,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        fontSize: 15,
        lineHeight: 22,
    },
    buttonContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 16,
    },
    button: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: 10,
    },
    secondaryButton: {
        borderWidth: 1,
    },
    buttonText: {
        fontSize: 15,
        fontWeight: '500',
    },
    hint: {
        fontSize: 13,
        marginTop: 16,
        lineHeight: 18,
    },
    saveContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: 'rgba(0,0,0,0.1)',
    },
    saveButton: {
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    saveButtonText: {
        color: '#FFFFFF',
        fontSize: 17,
        fontWeight: '600',
    },
}));
