/**
 * DuplicateSheet Component
 *
 * A bottom sheet that displays user messages from a Claude session.
 * Users can select a message to fork/duplicate the conversation from that point.
 * The selected message and everything after it will be removed in the new session.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    Platform,
    ScrollView,
    ActivityIndicator,
    Pressable,
    PanResponder,
    useWindowDimensions,
    ViewStyle,
    TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './StyledText';
import { layout } from './layout';
import { t } from '@/text';
import { Modal as ModalManager } from '@/modal';
import type { ClaudeUserMessageWithUuid } from '@/sync/ops';

// On web, stop events from propagating to expo-router's modal overlay
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface DuplicateSheetProps {
    visible: boolean;
    messages: ClaudeUserMessageWithUuid[] | null;
    loading: boolean;
    confirming?: boolean;
    onClose: () => void;
    onSelect: (uuid: string) => void;
    onClosed?: () => void;
}

const ANIMATION_DURATION = 250;
const MIN_HEIGHT_RATIO = 0.3;
const MAX_HEIGHT_RATIO = 0.9;
const DEFAULT_HEIGHT_RATIO = 0.7;
const MAX_PREVIEW_LENGTH = 100;

/**
 * Format timestamp to relative time string
 */
function formatRelativeTime(timestamp?: string): string {
    if (!timestamp) return '';

    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.justNow');
    if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
    return t('sessionHistory.daysAgo', { count: diffDays });
}

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength).trim() + '...';
}

export function DuplicateSheet({
    visible,
    messages,
    loading,
    confirming = false,
    onClose,
    onSelect,
    onClosed,
}: DuplicateSheetProps) {
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const { theme } = useUnistyles();
    const [modalVisible, setModalVisible] = useState(false);
    const [sheetHeight, setSheetHeight] = useState(windowHeight * DEFAULT_HEIGHT_RATIO);
    const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
    const currentHeightRef = useRef(windowHeight * DEFAULT_HEIGHT_RATIO);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(300)).current;
    const scrollViewRef = useRef<ScrollView>(null);
    const dragStartY = useRef(0);
    const dragStartHeight = useRef(0);

    const minHeight = windowHeight * MIN_HEIGHT_RATIO;
    const maxHeight = windowHeight * MAX_HEIGHT_RATIO;

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
                if (gestureState.vy > 0.5 && gestureState.dy > 50) {
                    onClose();
                }
            },
        })
    ).current;

    useEffect(() => {
        if (visible) {
            setModalVisible(true);
            setSelectedUuid(null);
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

    // Scroll to bottom when messages are loaded
    useEffect(() => {
        if (messages && messages.length > 0 && !loading) {
            // Small delay to ensure layout is complete
            setTimeout(() => {
                scrollViewRef.current?.scrollToEnd({ animated: false });
            }, 100);
        }
    }, [messages, loading]);

    const handleClose = () => {
        onClose();
    };

    const handleMessageSelect = (uuid: string) => {
        setSelectedUuid(uuid);
    };

    const handleConfirm = () => {
        if (selectedUuid) {
            ModalManager.alert(
                t('duplicate.confirmTitle'),
                t('duplicate.confirmMessage'),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('duplicate.confirm'), onPress: () => onSelect(selectedUuid) }
                ]
            );
        }
    };

    if (!modalVisible) {
        return null;
    }

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
                            <Ionicons name="git-branch" size={20} color="#fff" />
                        </View>
                        <View style={styles.headerContent as ViewStyle}>
                            <Text style={styles.title as TextStyle} numberOfLines={1}>{t('duplicate.title')}</Text>
                            <Text style={styles.subtitle as TextStyle}>{t('duplicate.description')}</Text>
                        </View>
                        <Pressable style={styles.closeButton as ViewStyle} onPress={handleClose}>
                            <Ionicons name="close" size={18} color="#8E8E93" />
                        </Pressable>
                    </View>

                    {/* Content */}
                    <ScrollView
                        ref={scrollViewRef}
                        style={styles.content as ViewStyle}
                        contentContainerStyle={styles.contentContainer as ViewStyle}
                        showsVerticalScrollIndicator={false}
                    >
                        {loading ? (
                            <View style={styles.loadingContainer as ViewStyle}>
                                <ActivityIndicator size="small" color="#8E8E93" />
                                <Text style={styles.loadingText as TextStyle}>{t('common.loading')}</Text>
                            </View>
                        ) : messages && messages.length > 0 ? (
                            <>
                                {messages.map((msg, index) => (
                                    <Pressable
                                        key={`${msg.uuid}-${index}`}
                                        onPress={() => handleMessageSelect(msg.uuid)}
                                        style={styles.messageItem as ViewStyle}
                                    >
                                        <View style={styles.messageContent as ViewStyle}>
                                            <Text style={styles.messageText as TextStyle} numberOfLines={1}>
                                                {truncateText(msg.content, MAX_PREVIEW_LENGTH)}
                                            </Text>
                                            {msg.timestamp && (
                                                <Text style={styles.messageTime as TextStyle}>
                                                    {formatRelativeTime(msg.timestamp)}
                                                </Text>
                                            )}
                                        </View>
                                        {selectedUuid === msg.uuid ? (
                                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                                        ) : (
                                            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.colors.divider }} />
                                        )}
                                    </Pressable>
                                ))}
                            </>
                        ) : (
                            <View style={styles.emptyContainer as ViewStyle}>
                                <Ionicons name="chatbubble-outline" size={48} color="#8E8E93" />
                                <Text style={styles.emptyText as TextStyle}>{t('duplicate.noMessages')}</Text>
                            </View>
                        )}
                    </ScrollView>

                    {/* Footer */}
                    <View style={styles.footer as ViewStyle}>
                        <Pressable
                            style={({ pressed }) => [
                                styles.confirmButton as ViewStyle,
                                (!selectedUuid || confirming) && styles.confirmButtonDisabled as ViewStyle,
                                pressed && selectedUuid && !confirming && styles.confirmButtonPressed as ViewStyle,
                            ]}
                            onPress={handleConfirm}
                            disabled={!selectedUuid || confirming}
                        >
                            {confirming ? (
                                <ActivityIndicator size="small" color="#fff" />
                            ) : (
                                <Ionicons name="git-branch" size={18} color="#fff" />
                            )}
                            <Text style={styles.confirmButtonText as TextStyle}>
                                {confirming ? t('duplicate.duplicating') : t('duplicate.confirm')}
                            </Text>
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
        backgroundColor: '#5856D6',
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
        gap: 8,
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
        gap: 12,
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    messageItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfacePressed,
        gap: 12,
    },
    messageContent: {
        flex: 1,
        minWidth: 0,
    },
    messageText: {
        fontSize: 15,
        color: theme.colors.text,
        lineHeight: 20,
    },
    messageTime: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    footer: {
        padding: 16,
        borderTopWidth: 0.5,
        borderTopColor: theme.colors.divider,
    },
    confirmButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#000',
        paddingVertical: 14,
        borderRadius: 10,
    },
    confirmButtonDisabled: {
        backgroundColor: theme.colors.divider,
    },
    confirmButtonPressed: {
        backgroundColor: '#1a1a1a',
    },
    confirmButtonText: {
        fontSize: 17,
        fontWeight: '500',
        color: '#fff',
    },
}));
