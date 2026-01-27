import * as React from 'react';
import { View, Platform, KeyboardAvoidingView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Octicons, Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ClawdbotSocket, useClawdbotStatus } from '@/clawdbot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@/components/layout';
import { MultiTextInput } from '@/components/MultiTextInput';
import { hapticsLight } from '@/components/haptics';

/**
 * Simplified composer for starting new Clawdbot sessions.
 * Styled to match the main app's AgentInput component.
 */
export default React.memo(function ClawdbotNewSessionScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { isConnected, mainSessionKey } = useClawdbotStatus();

    const [inputText, setInputText] = React.useState('');
    const [isSending, setIsSending] = React.useState(false);

    const hasText = inputText.trim().length > 0;

    const handleSend = React.useCallback(async () => {
        if (!inputText.trim() || isSending || !isConnected) return;

        const message = inputText.trim();
        setIsSending(true);
        hapticsLight();

        try {
            // Always create a new unique session key for new chats
            // (don't use mainSessionKey - that's the persistent "main" session)
            const sessionKey = `happy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Send the message to start the session
            await ClawdbotSocket.sendMessage(sessionKey, message);

            // Navigate to the chat screen
            router.replace({
                pathname: '/(app)/clawdbot/chat/[sessionKey]',
                params: { sessionKey }
            });
        } catch (err) {
            console.error('Failed to start session:', err);
            setIsSending(false);
        }
    }, [inputText, isSending, isConnected, mainSessionKey, router]);

    // Not connected state
    if (!isConnected) {
        return (
            <View style={[styles.centered, { backgroundColor: theme.colors.groupped.background }]}>
                <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                    {t('clawdbot.notConnected')}
                </Text>
                <Pressable
                    onPress={() => router.push('/(app)/clawdbot/connect')}
                    style={[styles.connectButton, { backgroundColor: theme.colors.button.primary.background }]}
                >
                    <Text style={[styles.connectButtonText, { color: '#FFFFFF' }]}>
                        {t('clawdbot.connectToGateway')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={[styles.container, { backgroundColor: theme.colors.groupped.background }]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            {/* Empty state with prompt */}
            <View style={styles.content}>
                <View style={styles.promptContainer}>
                    <Ionicons
                        name="chatbubble-ellipses-outline"
                        size={64}
                        color={theme.colors.textSecondary}
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={[styles.title, { color: theme.colors.text }]}>
                        {t('clawdbot.newSessionTitle')}
                    </Text>
                    <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                        {t('clawdbot.newSessionDescription')}
                    </Text>
                </View>
            </View>

            {/* Composer - matching AgentInput styling */}
            <View style={[
                styles.inputOuter,
                { paddingBottom: Math.max(insets.bottom, 8) },
            ]}>
                <View style={[styles.inputInner, { maxWidth: layout.maxWidth }]}>
                    <View style={[styles.unifiedPanel, { backgroundColor: theme.colors.input.background }]}>
                        {/* Input field */}
                        <View style={styles.inputContainer}>
                            <MultiTextInput
                                value={inputText}
                                onChangeText={setInputText}
                                placeholder={t('clawdbot.newSessionPlaceholder')}
                                paddingTop={Platform.OS === 'web' ? 10 : 8}
                                paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                maxHeight={120}
                            />
                        </View>

                        {/* Action buttons row */}
                        <View style={styles.actionRow}>
                            {/* Placeholder for future action chips */}
                            <View style={styles.actionLeft} />

                            {/* Send button */}
                            <View
                                style={[
                                    styles.sendButton,
                                    (hasText || isSending)
                                        ? { backgroundColor: theme.colors.button.primary.background }
                                        : { backgroundColor: theme.colors.button.primary.disabled }
                                ]}
                            >
                                <Pressable
                                    style={(p) => [
                                        styles.sendButtonInner,
                                        p.pressed && styles.sendButtonPressed,
                                    ]}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    onPress={handleSend}
                                    disabled={!hasText || isSending}
                                >
                                    {isSending ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={theme.colors.button.primary.tint}
                                        />
                                    ) : (
                                        <Octicons
                                            name="arrow-up"
                                            size={16}
                                            color={theme.colors.button.primary.tint}
                                            style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                                        />
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        paddingHorizontal: 32,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    promptContainer: {
        alignItems: 'center',
        maxWidth: 320,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 22,
        textAlign: 'center',
        marginBottom: 8,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 15,
        textAlign: 'center',
        lineHeight: 22,
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 14,
        textAlign: 'center',
    },
    connectButton: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 12,
        marginTop: 8,
    },
    connectButtonText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
    },
    // Composer styles matching AgentInput
    inputOuter: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
        paddingHorizontal: 8,
    },
    inputInner: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionLeft: {
        flex: 1,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonPressed: {
        opacity: 0.7,
    },
}));
