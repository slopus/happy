import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const COPY_FEEDBACK_DURATION_MS = 1_800;

export function CodeBlockCopyButton({ content, visible }: { content: string; visible: boolean }) {
    const { theme } = useUnistyles();
    const [status, setStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle');
    const [isFocused, setIsFocused] = React.useState(false);
    const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const resetLater = React.useCallback(() => {
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = null;
            setStatus('idle');
        }, COPY_FEEDBACK_DURATION_MS);
    }, []);

    React.useEffect(() => () => {
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    }, []);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(content);
            setStatus('copied');
        } catch (error) {
            console.error('Failed to copy code:', error);
            setStatus('failed');
        }
        resetLater();
    }, [content, resetLater]);

    const label = status === 'copied'
        ? t('common.copied')
        : status === 'failed'
            ? t('markdown.copyFailed')
            : t('common.copy');
    const iconName = status === 'copied'
        ? 'checkmark'
        : status === 'failed'
            ? 'alert-circle-outline'
            : 'copy-outline';
    const iconColor = status === 'copied'
        ? theme.colors.success
        : status === 'failed'
            ? theme.colors.status.error
            : theme.colors.textSecondary;

    return (
        <View style={[styles.wrapper, (visible || isFocused || status !== 'idle') && styles.wrapperVisible]}>
            <Pressable
                testID="markdown-code-copy"
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={copyCode}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                style={({ pressed }) => [
                    styles.button,
                    status === 'copied' && styles.buttonCopied,
                    status === 'failed' && styles.buttonFailed,
                    (pressed || isFocused) && styles.buttonPressed,
                ]}
            >
                <Ionicons
                    name={iconName}
                    size={14}
                    color={iconColor}
                />
                <Text style={[
                    styles.label,
                    status === 'copied' && styles.labelCopied,
                    status === 'failed' && styles.labelFailed,
                ]}>{label}</Text>
                {status !== 'idle' ? (
                    <Text
                        testID="markdown-code-copy-feedback"
                        accessibilityLiveRegion="polite"
                        style={styles.srFeedback}
                    >
                        {label}
                    </Text>
                ) : null}
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    wrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    wrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    button: {
        minHeight: 28,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        cursor: 'pointer',
    },
    buttonCopied: {
        borderColor: theme.colors.success,
    },
    buttonFailed: {
        borderColor: theme.colors.status.error,
    },
    buttonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    labelCopied: {
        color: theme.colors.success,
    },
    labelFailed: {
        color: theme.colors.status.error,
    },
    srFeedback: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
    },
}));
