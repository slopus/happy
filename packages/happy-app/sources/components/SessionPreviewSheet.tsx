/**
 * SessionPreviewSheet Component
 *
 * A bottom sheet that displays a preview of Claude session messages.
 * Shows the last N messages from a session before resuming.
 * Supports drag-to-resize functionality.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    Platform,
    FlatList,
    ActivityIndicator,
    Pressable,
    PanResponder,
    useWindowDimensions,
    ViewStyle,
    TextStyle,
    ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './StyledText';
import { layout } from './layout';
import { t } from '@/text';
import type { ClaudeSessionPreviewMessage, ClaudeSessionIndexEntry, AgentSessionIndexEntry } from '@/sync/ops';

// On web, stop events from propagating to expo-router's modal overlay
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface SessionPreviewSheetProps {
    visible: boolean;
    entry: ClaudeSessionIndexEntry | AgentSessionIndexEntry | null;
    messages: ClaudeSessionPreviewMessage[] | null;
    loading: boolean;
    onClose: () => void;
    onResume: () => void;
    onClosed?: () => void; // Called after close animation completes
}

const ANIMATION_DURATION = 250;
const MIN_HEIGHT_RATIO = 0.3;
const MAX_HEIGHT_RATIO = 0.9;
const DEFAULT_HEIGHT_RATIO = 0.7;
const PREVIEW_COLLAPSED_LINES = 6;

function getPreviewMessageKey(message: ClaudeSessionPreviewMessage, index?: number): string {
    return `${message.role}:${message.timestamp || 'no-ts'}:${index ?? 0}`;
}

export function SessionPreviewSheet({
    visible,
    entry,
    messages,
    loading,
    onClose,
    onResume,
    onClosed,
}: SessionPreviewSheetProps) {
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [modalVisible, setModalVisible] = useState(false);
    const [sheetHeight, setSheetHeight] = useState(windowHeight * DEFAULT_HEIGHT_RATIO);
    const [expandedMessageKeys, setExpandedMessageKeys] = useState<Set<string>>(new Set());
    const currentHeightRef = useRef(windowHeight * DEFAULT_HEIGHT_RATIO);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(300)).current;
    const dragStartY = useRef(0);
    const dragStartHeight = useRef(0);
    const lastLongPressAtRef = useRef(0);
    // Cache entry for display during close animation
    const cachedEntryRef = useRef<ClaudeSessionIndexEntry | AgentSessionIndexEntry | null>(null);
    if (entry) {
        cachedEntryRef.current = entry;
    }

    const minHeight = windowHeight * MIN_HEIGHT_RATIO;
    const maxHeight = windowHeight * MAX_HEIGHT_RATIO;

    // Update ref when state changes
    const updateSheetHeight = (height: number) => {
        currentHeightRef.current = height;
        setSheetHeight(height);
    };

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (_, gestureState) => {
                dragStartY.current = gestureState.y0;
                dragStartHeight.current = currentHeightRef.current;
            },
            onPanResponderMove: (_, gestureState) => {
                const deltaY = gestureState.moveY - dragStartY.current;
                const newHeight = dragStartHeight.current - deltaY;
                const clampedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
                updateSheetHeight(clampedHeight);
            },
            onPanResponderRelease: (_, gestureState) => {
                // If dragged down significantly and quickly, close the sheet
                if (gestureState.vy > 0.5 && gestureState.dy > 50) {
                    onClose();
                }
            },
        })
    ).current;

    useEffect(() => {
        if (visible) {
            setModalVisible(true);
            updateSheetHeight(windowHeight * DEFAULT_HEIGHT_RATIO);
            fadeAnim.setValue(0);
            slideAnim.setValue(300);
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: ANIMATION_DURATION,
                    useNativeDriver: true,
                }),
                Animated.spring(slideAnim, {
                    toValue: 0,
                    damping: 20,
                    stiffness: 300,
                    useNativeDriver: true,
                }),
            ]).start();
        } else if (modalVisible) {
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 0,
                    duration: ANIMATION_DURATION,
                    useNativeDriver: true,
                }),
                Animated.timing(slideAnim, {
                    toValue: 300,
                    duration: ANIMATION_DURATION,
                    useNativeDriver: true,
                }),
            ]).start(() => {
                setModalVisible(false);
                onClosed?.();
            });
        }
    }, [visible, onClosed]);

    useEffect(() => {
        setExpandedMessageKeys(new Set());
    }, [entry?.sessionId, visible]);

    const handleClose = () => {
        onClose();
    };

    const handleResume = () => {
        onResume();
    };

    const handleToggleMessageExpanded = useCallback((messageKey: string) => {
        setExpandedMessageKeys((prev) => {
            const next = new Set(prev);
            if (next.has(messageKey)) {
                next.delete(messageKey);
            } else {
                next.add(messageKey);
            }
            return next;
        });
    }, []);

    const previewMessages = messages ? [...messages].reverse() : [];

    if (!modalVisible) {
        return null;
    }

    // Use cached entry during close animation when entry becomes null
    const displayEntry = entry || cachedEntryRef.current;
    const title = displayEntry?.title || t('machine.untitledSession');
    const subtitle = displayEntry?.messageCount
        ? `${displayEntry.messageCount} messages${displayEntry.gitBranch ? ` \u2022 ${displayEntry.gitBranch}` : ''}`
        : displayEntry?.gitBranch || '';

    const hasOlderMessages = displayEntry?.messageCount && messages?.length
        ? displayEntry.messageCount > messages.length
        : false;

    return (
        <Modal
            visible={true}
            transparent={true}
            animationType="none"
            onRequestClose={handleClose}
        >
            <View style={[styles.container as ViewStyle, Platform.OS === 'web' && { pointerEvents: 'auto' as const }]} {...webEventHandlers}>
                <TouchableWithoutFeedback onPress={handleClose}>
                    <Animated.View
                        style={[
                            styles.backdrop as ViewStyle,
                            {
                                opacity: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 0.5],
                                }),
                            },
                        ]}
                    />
                </TouchableWithoutFeedback>

                <Animated.View
                    style={[
                        styles.sheet as ViewStyle,
                        {
                            height: sheetHeight,
                            opacity: fadeAnim,
                            transform: [{ translateY: slideAnim }],
                            paddingBottom: insets.bottom,
                        },
                    ]}
                >
                    {/* Handle - draggable */}
                    <View
                        style={[styles.handleContainer as ViewStyle, Platform.OS === 'web' && { cursor: 'ns-resize' as any }]}
                        {...panResponder.panHandlers}
                    >
                        <View style={styles.handle as ViewStyle} />
                    </View>

                    {/* Header */}
                    <View style={styles.header as ViewStyle}>
                        <View style={styles.headerIcon as ViewStyle}>
                            <Ionicons name="chatbubbles" size={20} color="#fff" />
                        </View>
                        <View style={styles.headerContent as ViewStyle}>
                            <Text style={styles.title as TextStyle} numberOfLines={1}>{title}</Text>
                            {subtitle ? <Text style={styles.subtitle as TextStyle}>{subtitle}</Text> : null}
                        </View>
                        <Pressable style={styles.closeButton as ViewStyle} onPress={handleClose}>
                            <Ionicons name="close" size={18} color="#8E8E93" />
                        </Pressable>
                    </View>

                    {/* Content - using inverted FlatList to avoid scroll flash */}
                    {loading ? (
                        <View style={[styles.content as ViewStyle, styles.loadingContainer as ViewStyle]}>
                            <ActivityIndicator size="small" color="#8E8E93" />
                            <Text style={styles.loadingText as TextStyle}>{t('common.loading')}</Text>
                        </View>
                    ) : (
                        <FlatList
                            data={previewMessages}
                            inverted={true}
                            style={styles.content as ViewStyle}
                            contentContainerStyle={styles.contentContainer as ViewStyle}
                            showsVerticalScrollIndicator={false}
                            keyExtractor={getPreviewMessageKey}
                            renderItem={({ item: msg, index }: ListRenderItemInfo<ClaudeSessionPreviewMessage>) => {
                                const messageKey = getPreviewMessageKey(msg, index);
                                const isExpanded = expandedMessageKeys.has(messageKey);

                                return (
                                    <View
                                        style={[
                                            styles.message as ViewStyle,
                                            msg.role === 'user' ? styles.userMessage as ViewStyle : styles.assistantMessage as ViewStyle,
                                        ]}
                                    >
                                        <View
                                            style={[
                                                styles.messageBubble as ViewStyle,
                                                msg.role === 'user' ? styles.userBubble as ViewStyle : styles.assistantBubble as ViewStyle,
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.messageText as TextStyle,
                                                    msg.role === 'user' ? styles.userText as TextStyle : styles.assistantText as TextStyle,
                                                ]}
                                                selectable={true}
                                                suppressHighlighting={true}
                                                onLongPress={() => {
                                                    lastLongPressAtRef.current = Date.now();
                                                }}
                                                onPress={() => {
                                                    // Ignore the press that may be fired after long press.
                                                    if (Date.now() - lastLongPressAtRef.current < 800) {
                                                        return;
                                                    }
                                                    handleToggleMessageExpanded(messageKey);
                                                }}
                                                numberOfLines={isExpanded ? undefined : PREVIEW_COLLAPSED_LINES}
                                            >
                                                {msg.content}
                                            </Text>
                                        </View>
                                    </View>
                                );
                            }}
                            ListEmptyComponent={
                                <View style={styles.emptyContainer as ViewStyle}>
                                    <Text style={styles.emptyText as TextStyle}>{t('sessionPreview.noMessages')}</Text>
                                </View>
                            }
                            ListFooterComponent={hasOlderMessages ? (
                                <Text style={styles.olderMessagesHint as TextStyle}>
                                    {t('sessionPreview.olderMessagesHint')}
                                </Text>
                            ) : null}
                        />
                    )}

                    {/* Footer */}
                    <View style={styles.footer as ViewStyle}>
                        <Pressable
                            style={({ pressed }) => [
                                styles.resumeButton as ViewStyle,
                                pressed && styles.resumeButtonPressed as ViewStyle,
                            ]}
                            onPress={handleResume}
                        >
                            <Ionicons name="play" size={18} color="#fff" />
                            <Text style={styles.resumeButtonText as TextStyle}>{t('sessionPreview.resume')}</Text>
                        </Pressable>
                    </View>
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'flex-end',
        alignItems: 'center',
    },
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'black',
    },
    sheet: {
        width: '100%',
        maxWidth: Math.min(layout.maxWidth, 768),
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        overflow: 'hidden',
    },
    handleContainer: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    handle: {
        width: 36,
        height: 5,
        backgroundColor: theme.colors.divider,
        borderRadius: 2.5,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.colors.divider,
        gap: 12,
    },
    headerIcon: {
        width: 40,
        height: 40,
        borderRadius: 10,
        backgroundColor: '#D97757',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerContent: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    closeButton: {
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: theme.colors.surfacePressed,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        flex: 1,
    },
    contentContainer: {
        padding: 16,
        gap: 12,
        flexGrow: 1,
    },
    loadingContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 40,
        gap: 12,
    },
    loadingText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 40,
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    olderMessagesHint: {
        textAlign: 'center',
        fontSize: 13,
        color: theme.colors.textSecondary,
        paddingVertical: 8,
        marginTop: 4,
    },
    message: {
        maxWidth: '85%',
    },
    userMessage: {
        alignSelf: 'flex-end',
    },
    assistantMessage: {
        alignSelf: 'flex-start',
    },
    messageBubble: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 16,
    },
    userBubble: {
        backgroundColor: theme.colors.userMessageBackground,
        borderBottomRightRadius: 4,
    },
    assistantBubble: {
        backgroundColor: theme.colors.surfacePressed,
        borderBottomLeftRadius: 4,
    },
    messageText: {
        fontSize: 15,
        lineHeight: 20,
    },
    userText: {
        color: theme.colors.userMessageText,
    },
    assistantText: {
        color: theme.colors.agentMessageText,
    },
    footer: {
        padding: 16,
        borderTopWidth: 0.5,
        borderTopColor: theme.colors.divider,
    },
    resumeButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#000',
        paddingVertical: 14,
        borderRadius: 10,
    },
    resumeButtonPressed: {
        backgroundColor: '#1a1a1a',
    },
    resumeButtonText: {
        fontSize: 17,
        fontWeight: '500',
        color: '#fff',
    },
}));
