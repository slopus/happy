import * as React from 'react';
import { View, Text, Modal, Pressable, ScrollView, useWindowDimensions, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const QUICK_EMOJIS = ['❤️', '👍', '👎', '🔥', '🥳', '👏', '😁'];

export type ContextMenuAction = {
    label: string;
    icon?: string; // Ionicons name
    destructive?: boolean;
    onPress: () => void;
};

export type MessagePreview = {
    content: React.ReactNode;
    senderName?: string;
    isSelf: boolean;
};

type MessageContextMenuProps = {
    visible: boolean;
    messageY: number;
    messageHeight: number;
    actions: ContextMenuAction[];
    preview?: MessagePreview;
    onEmojiSelect: (symbol: string) => void;
    onClose: () => void;
};

export function MessageContextMenu({
    visible,
    messageY,
    actions,
    preview,
    onEmojiSelect,
    onClose,
}: MessageContextMenuProps) {
    const { theme } = useUnistyles();
    const { height: screenH } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    React.useEffect(() => {
        if (visible && Platform.OS !== 'web') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
    }, [visible]);

    if (!visible) return null;

    // Calculate vertical position — try to anchor near the message,
    // but always keep the entire menu within screen safe area.
    const EMOJI_BAR_H = 52;
    const PREVIEW_H = preview ? 104 : 0; // maxHeight 80 + padding 20 + sender ~4
    const ACTION_ITEM_H = 48;
    const ACTIONS_H = actions.length * ACTION_ITEM_H + 16;
    const GAP = 8;
    const GAPS = GAP + (preview ? GAP : 0) + GAP; // between emoji/preview/actions
    const TOTAL_H = EMOJI_BAR_H + PREVIEW_H + ACTIONS_H + GAPS;
    const EXTRA = 8; // small extra margin beyond safe area
    const safeTop = insets.top + EXTRA;
    const safeBottom = insets.bottom + EXTRA;
    const availableH = screenH - safeTop - safeBottom;

    // Start with emoji bar above the message position
    let topY = messageY - EMOJI_BAR_H - GAP;
    // Push up if overflowing bottom
    if (topY + TOTAL_H > screenH - safeBottom) {
        topY = screenH - safeBottom - TOTAL_H;
    }
    // Push down if overflowing top
    if (topY < safeTop) topY = safeTop;

    // If total content exceeds available space, cap and enable scrolling
    const needsScroll = TOTAL_H > availableH;
    const containerMaxH = needsScroll ? availableH : undefined;

    const menuContent = (
        <>
            {/* Emoji quick bar */}
            <View style={[menuStyles.emojiBar, { backgroundColor: theme.colors.surface }]}>
                {QUICK_EMOJIS.map((emoji) => (
                    <Pressable
                        key={emoji}
                        onPress={() => { onEmojiSelect(emoji); onClose(); }}
                        style={menuStyles.emojiButton}
                    >
                        <Text style={menuStyles.emojiText}>{emoji}</Text>
                    </Pressable>
                ))}
            </View>

            {/* Message preview */}
            {preview ? (
                <View style={[
                    menuStyles.previewCard,
                    {
                        backgroundColor: preview.isSelf ? theme.colors.surfaceHigh : theme.colors.surface,
                        alignSelf: preview.isSelf ? 'flex-end' : 'flex-start',
                    },
                ]}>
                    {preview.senderName && !preview.isSelf ? (
                        <Text style={[menuStyles.previewSender, { color: theme.colors.textLink }]} numberOfLines={1}>
                            {preview.senderName}
                        </Text>
                    ) : null}
                    <View style={menuStyles.previewContent}>
                        {preview.content}
                    </View>
                </View>
            ) : null}

            {/* Action list */}
            <View style={[menuStyles.actionList, { backgroundColor: theme.colors.surface }]}>
                {actions.map((action, i) => (
                    <Pressable
                        key={action.label}
                        onPress={() => { action.onPress(); onClose(); }}
                        style={({ pressed }) => [
                            menuStyles.actionItem,
                            pressed && { backgroundColor: theme.colors.surfaceHigh },
                            i < actions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
                        ]}
                    >
                        <Text style={[
                            menuStyles.actionLabel,
                            { color: action.destructive ? theme.colors.textDestructive : theme.colors.text },
                        ]}>
                            {action.label}
                        </Text>
                        {action.icon ? (
                            <Ionicons
                                name={action.icon as any}
                                size={20}
                                color={action.destructive ? theme.colors.textDestructive : theme.colors.textSecondary}
                            />
                        ) : null}
                    </Pressable>
                ))}
            </View>
        </>
    );

    return (
        <Modal transparent visible animationType="none" onRequestClose={onClose}>
            <View style={menuStyles.overlay}>
                {/* Blur backdrop */}
                <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose}>
                    <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFillObject} />
                </Pressable>

                <Animated.View
                    entering={FadeIn.duration(200)}
                    exiting={FadeOut.duration(150)}
                    style={[menuStyles.container, { top: topY, maxHeight: containerMaxH }]}
                >
                    {needsScroll ? (
                        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
                            {menuContent}
                        </ScrollView>
                    ) : menuContent}
                </Animated.View>
            </View>
        </Modal>
    );
}

// --- Styles ---

const menuStyles = StyleSheet.create((theme) => ({
    overlay: {
        flex: 1,
    },
    container: {
        position: 'absolute',
        left: theme.margins.lg,
        right: theme.margins.lg,
        gap: 8,
    },
    emojiBar: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 28,
        alignSelf: 'center',
    },
    emojiButton: {
        width: 40,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
    },
    emojiText: {
        fontSize: 24,
    },
    previewCard: {
        maxWidth: '85%',
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 14,
    },
    previewSender: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        marginBottom: 2,
    },
    previewContent: {
        maxHeight: 80,
        overflow: 'hidden',
    },
    actionList: {
        borderRadius: 14,
        overflow: 'hidden',
        paddingVertical: 4,
    },
    actionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        height: 48,
    },
    actionLabel: {
        ...Typography.default(),
        fontSize: 16,
    },
}));
