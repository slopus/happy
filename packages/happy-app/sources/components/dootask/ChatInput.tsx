import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { MultiTextInput } from '@/components/MultiTextInput';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

type ChatInputProps = {
    onSendText: (text: string) => void;
    onSendImage: (base64DataUri: string) => void;
    onSendFile?: (file: { uri: string; name: string; mimeType: string }) => void;
    replyTo?: { msg: DooTaskDialogMsg; senderName: string } | null;
    onCancelReply?: () => void;
};

function getPreviewText(msg: DooTaskDialogMsg): string {
    if (typeof msg.msg === 'string') return msg.msg;
    if (msg.msg?.text) return msg.msg.text.replace(/<[^>]*>/g, '').slice(0, 100);
    if (msg.type === 'image') return '[Image]';
    if (msg.type === 'file') return `[File] ${msg.msg?.name || ''}`;
    return '[Message]';
}

export const ChatInput = React.memo(({ onSendText, onSendImage, onSendFile, replyTo, onCancelReply }: ChatInputProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [text, setText] = React.useState('');
    const [menuVisible, setMenuVisible] = React.useState(false);
    const latestTextRef = React.useRef(text);

    const canSend = text.trim().length > 0;

    const handleTextChange = React.useCallback((value: string) => {
        latestTextRef.current = value;
        setText(value);
    }, []);

    const handleSend = React.useCallback(() => {
        const trimmed = latestTextRef.current.trim();
        if (!trimmed) return;
        onSendText(trimmed);
        latestTextRef.current = '';
        setText('');
    }, [onSendText]);

    const handlePickFromCamera = React.useCallback(async () => {
        try {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') return;
            const result = await ImagePicker.launchCameraAsync({
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
            console.error('[ChatInput] Camera capture failed:', error);
        }
    }, [onSendImage]);

    const handlePickFromAlbum = React.useCallback(async () => {
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

    const handlePickFile = React.useCallback(async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                copyToCacheDirectory: true,
            });
            if (!result.canceled && result.assets?.[0]) {
                const asset = result.assets[0];
                onSendFile?.({
                    uri: asset.uri,
                    name: asset.name,
                    mimeType: asset.mimeType || 'application/octet-stream',
                });
            }
        } catch (error) {
            console.error('[ChatInput] File pick failed:', error);
        }
    }, [onSendFile]);

    const menuItems: ActionMenuItem[] = React.useMemo(() => [
        { label: t('dootask.takePhoto'), onPress: handlePickFromCamera },
        { label: t('dootask.chooseFromAlbum'), onPress: handlePickFromAlbum },
        { label: t('dootask.chooseFromFile'), onPress: handlePickFile },
    ], [handlePickFromCamera, handlePickFromAlbum, handlePickFile]);

    return (
        <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 12) }]}>
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
                    onPress={() => setMenuVisible(true)}
                    hitSlop={4}
                    style={styles.addButton}
                >
                    <View style={[styles.addCircle, { backgroundColor: theme.colors.surfaceHighest }]}>
                        <Ionicons name="add" size={24} color={theme.colors.textSecondary} />
                    </View>
                </Pressable>
                <View style={[styles.inputGroup, { backgroundColor: theme.colors.surfaceHighest }]}>
                    <MultiTextInput
                        style={{ flex: 1, paddingVertical: 6 }}
                        value={text}
                        onChangeText={handleTextChange}
                        placeholder={t('dootask.typeMessage')}
                        maxHeight={120}
                        paddingTop={6}
                        paddingBottom={6}
                        lineHeight={20}
                    />
                    <Pressable
                        onPress={handleSend}
                        accessibilityState={{ disabled: !canSend }}
                        hitSlop={4}
                        style={styles.sendButton}
                    >
                        <View style={[
                            styles.sendCircle,
                            { backgroundColor: canSend ? theme.colors.button.primary.background : theme.colors.button.primary.disabled },
                        ]}>
                            <Ionicons name="arrow-up" size={20} color={theme.colors.button.primary.tint} />
                        </View>
                    </Pressable>
                </View>
            </View>
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
                deferItemPress
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.header.background,
        paddingHorizontal: 10,
        paddingTop: theme.margins.xs,
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
        gap: theme.margins.sm,
    },
    addButton: {
        width: 42,
        height: 42,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 1,
    },
    addCircle: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputGroup: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-end',
        borderRadius: 22,
        paddingLeft: theme.margins.md + 4,
        paddingRight: 4,
        minHeight: 44,
    },
    sendButton: {
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginBottom: 5,
    },
    sendCircle: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
