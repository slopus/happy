import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, Animated } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSendConfirmationSeconds } from '@/sync/voiceConfig';

interface SendConfirmationModalProps {
    message: string;
    countdownSeconds: number;
    onResult: (result: 'sent' | 'cancelled') => void;
    onClose: () => void;
}

function SendConfirmationModalContent({ message, countdownSeconds, onResult, onClose }: SendConfirmationModalProps) {
    const { theme } = useUnistyles();
    const [secondsLeft, setSecondsLeft] = useState(countdownSeconds);
    const progressAnim = useRef(new Animated.Value(1)).current;
    const doneRef = useRef(false);

    const finish = useCallback((result: 'sent' | 'cancelled') => {
        if (doneRef.current) return;
        doneRef.current = true;
        onResult(result);
        onClose();
    }, [onResult, onClose]);

    // Auto-send when countdown reaches 0
    useEffect(() => {
        if (secondsLeft <= 0) {
            finish('sent');
        }
    }, [secondsLeft, finish]);

    useEffect(() => {
        // Animate progress bar from full to empty
        Animated.timing(progressAnim, {
            toValue: 0,
            duration: countdownSeconds * 1000,
            useNativeDriver: false,
        }).start();

        // Countdown timer
        const interval = setInterval(() => {
            setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.title, { color: theme.colors.text }]}>
                {t('voiceSendConfirmation.title')}
            </Text>

            <View style={[styles.messageBox, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Text style={[styles.messageText, { color: theme.colors.text }]} numberOfLines={6}>
                    {message}
                </Text>
            </View>

            <View style={[styles.progressTrack, { backgroundColor: theme.colors.divider }]}>
                <Animated.View
                    style={[
                        styles.progressBar,
                        {
                            backgroundColor: theme.colors.textLink,
                            width: progressAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: ['0%', '100%'],
                            }),
                        },
                    ]}
                />
            </View>

            <Text style={[styles.countdown, { color: theme.colors.textSecondary }]}>
                {t('voiceSendConfirmation.countdown', { seconds: secondsLeft })}
            </Text>

            <View style={styles.buttons}>
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh },
                    ]}
                    onPress={() => finish('cancelled')}
                >
                    <Text style={[styles.buttonText, { color: theme.colors.textDestructive }]}>
                        {t('voiceSendConfirmation.cancel')}
                    </Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        {
                            backgroundColor: theme.colors.button.primary.background,
                            opacity: pressed ? 0.8 : 1,
                        },
                    ]}
                    onPress={() => finish('sent')}
                >
                    <Text style={[styles.buttonText, { color: theme.colors.button.primary.tint }]}>
                        {t('voiceSendConfirmation.sendNow')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

export function showSendConfirmation(message: string): Promise<'sent' | 'cancelled'> {
    const countdownSeconds = getSendConfirmationSeconds();

    return new Promise((resolve) => {
        let resolved = false;
        const onResult = (result: 'sent' | 'cancelled') => {
            if (resolved) return;
            resolved = true;
            resolve(result);
        };

        const modalId = Modal.show({
            component: SendConfirmationModalContent,
            props: {
                message,
                countdownSeconds,
                onResult,
            },
        });

        // Safety: if modal is dismissed externally (e.g. backdrop tap, Modal.hideAll),
        // the component unmounts without calling onResult.
        // Poll briefly to detect this and resolve the promise.
        const check = setInterval(() => {
            if (!resolved) return;
            clearInterval(check);
        }, 500);

        // Fallback: resolve after max wait to prevent forever-pending promise
        setTimeout(() => {
            clearInterval(check);
            if (!resolved) {
                resolved = true;
                Modal.hide(modalId);
                resolve('cancelled');
            }
        }, (countdownSeconds + 2) * 1000);
    });
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: 320,
        borderRadius: 16,
        padding: 20,
        borderWidth: 1,
        borderColor: theme.colors.modal.border,
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        marginBottom: 16,
        ...Typography.default('semiBold'),
    },
    messageBox: {
        borderRadius: 10,
        padding: 12,
        marginBottom: 16,
    },
    messageText: {
        fontSize: 15,
        lineHeight: 21,
        ...Typography.default(),
    },
    progressTrack: {
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        marginBottom: 8,
    },
    progressBar: {
        height: '100%',
        borderRadius: 2,
    },
    countdown: {
        fontSize: 13,
        textAlign: 'center',
        marginBottom: 16,
        ...Typography.default(),
    },
    buttons: {
        flexDirection: 'row',
        gap: 10,
    },
    button: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
    },
    buttonPrimary: {},
    buttonText: {
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
}));
