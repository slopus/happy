import * as React from 'react';
import { View, Text, Modal, Pressable, useWindowDimensions, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

const QUICK_EMOJIS = ['❤️', '👍', '👎', '🔥', '🥳', '👏', '😁'];

export type ContextMenuAction = {
    label: string;
    icon?: string; // Ionicons name
    destructive?: boolean;
    onPress: () => void;
};

type MessageContextMenuProps = {
    visible: boolean;
    messageY: number;
    messageHeight: number;
    actions: ContextMenuAction[];
    onEmojiSelect: (symbol: string) => void;
    onClose: () => void;
    children?: React.ReactNode;
};

export function MessageContextMenu({
    visible,
    messageY,
    messageHeight,
    actions,
    onEmojiSelect,
    onClose,
    children,
}: MessageContextMenuProps) {
    const { theme } = useUnistyles();
    const { height: screenH } = useWindowDimensions();

    React.useEffect(() => {
        if (visible && Platform.OS !== 'web') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
    }, [visible]);

    if (!visible) return null;

    // Calculate vertical position
    const EMOJI_BAR_H = 52;
    const ACTION_ITEM_H = 48;
    const ACTIONS_H = actions.length * ACTION_ITEM_H + 16;
    const TOTAL_H = EMOJI_BAR_H + messageHeight + ACTIONS_H;
    const PADDING = 20;

    let topY = messageY - EMOJI_BAR_H;
    if (topY + TOTAL_H > screenH - PADDING) {
        topY = screenH - PADDING - TOTAL_H;
    }
    if (topY < PADDING) topY = PADDING;

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
                    style={[menuStyles.container, { top: topY }]}
                >
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
                    <View style={menuStyles.messagePreview}>
                        {children}
                    </View>

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
    messagePreview: {
        // Message is rendered by parent via children prop
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
