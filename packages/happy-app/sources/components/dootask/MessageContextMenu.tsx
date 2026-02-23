import * as React from 'react';
import { View, Text, Modal, Pressable, useWindowDimensions, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const QUICK_EMOJIS = ['❤️', '👍', '👎', '🔥', '🥳', '👏', '😁'];
const FADE_IN_MS = 200;
const FADE_OUT_MS = 150;

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

    // Two-phase show/hide: fade content first, then unmount Modal.
    const [modalVisible, setModalVisible] = React.useState(false);
    const opacity = useSharedValue(0);

    // Snapshot content props so they stay stable during fade-out
    // (parent sets contextMenu=null immediately on close, emptying props)
    const snapshotRef = React.useRef<{
        actions: ContextMenuAction[];
        preview?: MessagePreview;
        onEmojiSelect: (symbol: string) => void;
        onClose: () => void;
        topY: number;
    }>({ actions: [], onEmojiSelect: () => {}, onClose: () => {}, topY: 0 });

    React.useEffect(() => {
        if (visible) {
            setModalVisible(true);
            opacity.value = withTiming(1, { duration: FADE_IN_MS });
            if (Platform.OS !== 'web') {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }
        } else if (modalVisible) {
            opacity.value = withTiming(0, { duration: FADE_OUT_MS });
            const timer = setTimeout(() => setModalVisible(false), FADE_OUT_MS);
            return () => clearTimeout(timer);
        }
    }, [visible]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    // Calculate position and snapshot when open
    const EMOJI_BAR_H = 52;
    const GAP = 8;
    const EXTRA = 8;
    const safeTop = insets.top + EXTRA;
    const safeBottom = insets.bottom + EXTRA;

    if (visible) {
        // Snapshot all content props while menu is open
        snapshotRef.current = { actions, preview, onEmojiSelect, onClose, topY: 0 };

        const PREVIEW_H = preview ? 104 : 0;
        const ACTION_ITEM_H = 48;
        const ACTIONS_H = actions.length * ACTION_ITEM_H + 16;
        const GAPS = GAP + (preview ? GAP : 0) + GAP;
        const TOTAL_H = EMOJI_BAR_H + PREVIEW_H + ACTIONS_H + GAPS;

        let topY = messageY - EMOJI_BAR_H - GAP;
        if (topY + TOTAL_H > screenH - safeBottom) {
            topY = screenH - safeBottom - TOTAL_H;
        }
        if (topY < safeTop) topY = safeTop;
        snapshotRef.current.topY = topY;
    }

    // Always read from snapshot for rendering (stable during fade-out)
    const snap = snapshotRef.current;

    return (
        <Modal transparent visible={modalVisible} animationType="none" onRequestClose={snap.onClose}>
            <Animated.View style={[menuStyles.overlay, animatedStyle]}>
                <Pressable style={StyleSheet.absoluteFillObject} onPress={snap.onClose}>
                    <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFillObject} />
                </Pressable>

                <View style={[menuStyles.container, { top: snap.topY }]}>
                    {/* Emoji quick bar */}
                    <View style={[menuStyles.emojiBar, { backgroundColor: theme.colors.surface }]}>
                        {QUICK_EMOJIS.map((emoji) => (
                            <Pressable
                                key={emoji}
                                onPress={() => { snap.onEmojiSelect(emoji); snap.onClose(); }}
                                style={menuStyles.emojiButton}
                            >
                                <Text style={menuStyles.emojiText}>{emoji}</Text>
                            </Pressable>
                        ))}
                    </View>

                    {/* Message preview */}
                    {snap.preview ? (
                        <View style={[
                            menuStyles.previewCard,
                            {
                                backgroundColor: snap.preview.isSelf ? theme.colors.surfaceHigh : theme.colors.surface,
                                alignSelf: snap.preview.isSelf ? 'flex-end' : 'flex-start',
                            },
                        ]}>
                            {snap.preview.senderName && !snap.preview.isSelf ? (
                                <Text style={[menuStyles.previewSender, { color: theme.colors.textLink }]} numberOfLines={1}>
                                    {snap.preview.senderName}
                                </Text>
                            ) : null}
                            <View style={menuStyles.previewContent}>
                                {snap.preview.content}
                            </View>
                        </View>
                    ) : null}

                    {/* Action list */}
                    <View style={[menuStyles.actionList, { backgroundColor: theme.colors.surface }]}>
                        {snap.actions.map((action, i) => (
                            <Pressable
                                key={action.label}
                                onPress={() => { action.onPress(); snap.onClose(); }}
                                style={({ pressed }) => [
                                    menuStyles.actionItem,
                                    pressed && { backgroundColor: theme.colors.surfaceHigh },
                                    i < snap.actions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
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
                </View>
            </Animated.View>
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
