import * as React from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

type ChatInputProps = {
    onSendText: (text: string) => void;
    onSendImage: (base64DataUri: string) => void;
    replyTo?: { msg: DooTaskDialogMsg; senderName: string } | null;
    onCancelReply?: () => void;
    sending?: boolean;
};

function getPreviewText(msg: DooTaskDialogMsg): string {
    if (typeof msg.msg === 'string') return msg.msg;
    if (msg.msg?.text) return msg.msg.text.replace(/<[^>]*>/g, '').slice(0, 100);
    if (msg.type === 'image') return '[Image]';
    if (msg.type === 'file') return `[File] ${msg.msg?.name || ''}`;
    return '[Message]';
}

export const ChatInput = React.memo(({ onSendText, onSendImage, replyTo, onCancelReply, sending }: ChatInputProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [text, setText] = React.useState('');

    const canSend = text.trim().length > 0 && !sending;

    const handleSend = React.useCallback(() => {
        const trimmed = text.trim();
        if (!trimmed || sending) return;
        onSendText(trimmed);
        setText('');
    }, [text, sending, onSendText]);

    const handlePickImage = React.useCallback(async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                base64: true,
                quality: 0.8,
            });

            if (!result.canceled && result.assets[0]?.base64) {
                const asset = result.assets[0];
                const ext = asset.mimeType?.split('/')[1] || 'jpeg';
                const dataUri = `data:image/${ext};base64,${asset.base64}`;
                onSendImage(dataUri);
            }
        } catch (error) {
            console.error('[ChatInput] Image pick failed:', error);
        }
    }, [onSendImage]);

    return (
        <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {replyTo && (
                <View style={styles.replyBar}>
                    <View style={styles.replyContent}>
                        <Text style={styles.replySender} numberOfLines={1}>
                            {replyTo.senderName}
                        </Text>
                        <Text style={styles.replyText} numberOfLines={1}>
                            {getPreviewText(replyTo.msg)}
                        </Text>
                    </View>
                    <Pressable
                        onPress={onCancelReply}
                        hitSlop={8}
                        style={styles.replyClose}
                    >
                        <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            )}
            <View style={styles.inputRow}>
                <Pressable
                    onPress={handlePickImage}
                    hitSlop={4}
                    style={styles.iconButton}
                >
                    <Ionicons name="image-outline" size={24} color={theme.colors.textSecondary} />
                </Pressable>
                <TextInput
                    style={styles.textInput}
                    value={text}
                    onChangeText={setText}
                    placeholder={t('dootask.typeMessage')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    multiline
                    numberOfLines={5}
                    textAlignVertical="center"
                />
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    hitSlop={4}
                    style={styles.iconButton}
                >
                    <Ionicons
                        name="send"
                        size={22}
                        color={canSend ? theme.colors.textLink : theme.colors.input.placeholder}
                    />
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.margins.sm,
    },
    replyBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.margins.sm,
        paddingHorizontal: theme.margins.sm,
        backgroundColor: theme.colors.surfaceHigh,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.textLink,
        borderRadius: theme.borderRadius.sm,
        marginTop: theme.margins.sm,
        marginHorizontal: theme.margins.xs,
    },
    replyContent: {
        flex: 1,
        marginRight: theme.margins.sm,
    },
    replySender: {
        fontSize: 13,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
    replyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    replyClose: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingVertical: theme.margins.sm,
        gap: theme.margins.xs,
    },
    iconButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textInput: {
        flex: 1,
        minHeight: 36,
        maxHeight: 120,
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.lg,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.sm,
        fontSize: 15,
        color: theme.colors.input.text,
        ...Typography.default(),
    },
}));
