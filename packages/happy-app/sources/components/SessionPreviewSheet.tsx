/**
 * SessionPreviewSheet Component
 *
 * A bottom sheet that displays a preview of Claude session messages.
 * Shows the last N messages from a session before resuming.
 * Supports drag-to-resize functionality.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
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
import * as Clipboard from 'expo-clipboard';
import { hapticsLight } from './haptics';
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
    const pressInAtRef = useRef(0);
    const touchStartYRef = useRef(0);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [copyMenu, setCopyMenu] = useState<{ x: number; y: number; content: string } | null>(null);
    const copyMenuRef = useRef<{ x: number; y: number; content: string } | null>(null);
    const copyMenuAnim = useRef(new Animated.Value(0)).current;
    const [copyMenuWidth, setCopyMenuWidth] = useState(0);
    const [localToastVisible, setLocalToastVisible] = useState(false);
    const localToastAnim = useRef(new Animated.Value(0)).current;
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
        setCopyMenu(null);
    }, [entry?.sessionId, visible]);

    useEffect(() => {
        return () => {
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
    }, []);

    const cancelLongPress = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const showCopyMenu = useCallback((menu: { x: number; y: number; content: string }) => {
        copyMenuRef.current = menu;
        copyMenuAnim.setValue(0);
        setCopyMenu(menu);
        Animated.spring(copyMenuAnim, {
            toValue: 1,
            damping: 15,
            stiffness: 300,
            useNativeDriver: true,
        }).start();
    }, [copyMenuAnim]);

    const hideCopyMenu = useCallback(() => {
        copyMenuRef.current = null;
        Animated.timing(copyMenuAnim, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
        }).start(() => setCopyMenu(null));
    }, [copyMenuAnim]);

    const showLocalToast = useCallback(() => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setLocalToastVisible(true);
        localToastAnim.setValue(1);
        toastTimerRef.current = setTimeout(() => {
            toastTimerRef.current = null;
            Animated.timing(localToastAnim, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => {
                setLocalToastVisible(false);
            });
        }, 1200);
    }, [localToastAnim]);

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

    const previewMessages = useMemo(() => messages ? [...messages].reverse() : [], [messages]);

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
                            onScroll={cancelLongPress}
                            scrollEventThrottle={16}
                            onScrollBeginDrag={hideCopyMenu}
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
                                            onTouchStart={(e) => {
                                                pressInAtRef.current = Date.now();
                                                touchStartYRef.current = e.nativeEvent.pageY;
                                                const { pageX, pageY } = e.nativeEvent;
                                                cancelLongPress();
                                                longPressTimerRef.current = setTimeout(() => {
                                                    longPressTimerRef.current = null;
                                                    hapticsLight();
                                                    showCopyMenu({ x: pageX, y: pageY, content: msg.content });
                                                }, 500);
                                            }}
                                            onTouchMove={cancelLongPress}
                                            onTouchEnd={(e) => {
                                                cancelLongPress();
                                                const elapsed = Date.now() - pressInAtRef.current;
                                                if (elapsed > 400) return;
                                                if (Math.abs(e.nativeEvent.pageY - touchStartYRef.current) > 8) return;
                                                if (copyMenuRef.current !== null) {
                                                    hideCopyMenu();
                                                    return;
                                                }
                                                handleToggleMessageExpanded(messageKey);
                                            }}
                                        >
                                            <Text
                                                style={[
                                                    styles.messageText as TextStyle,
                                                    msg.role === 'user' ? styles.userText as TextStyle : styles.assistantText as TextStyle,
                                                ]}
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

                {/* Copy menu overlay — rendered at modal level to avoid clipping */}
                {copyMenu && (
                    <>
                        <TouchableWithoutFeedback onPress={hideCopyMenu}>
                            <View style={styles.copyMenuBackdrop as ViewStyle} />
                        </TouchableWithoutFeedback>
                        <Animated.View
                            style={[
                                styles.copyMenuContainer as ViewStyle,
                                { left: copyMenu.x - copyMenuWidth / 2, top: copyMenu.y - 48 },
                                {
                                    opacity: copyMenuAnim,
                                    transform: [
                                        { scale: copyMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
                                    ],
                                },
                            ]}
                            pointerEvents="box-none"
                            onLayout={(e) => setCopyMenuWidth(e.nativeEvent.layout.width)}
                        >
                            <Pressable
                                style={styles.copyMenuButton as ViewStyle}
                                onPress={() => {
                                    Clipboard.setStringAsync(copyMenu.content);
                                    hapticsLight(); showLocalToast();
                                    hideCopyMenu();
                                }}
                            >
                                <Text style={styles.copyMenuText as TextStyle}>{t('common.copy')}</Text>
                            </Pressable>
                            <View style={styles.copyMenuArrow as ViewStyle} />
                        </Animated.View>
                    </>
                )}

                {/* Local toast inside Modal to avoid being covered */}
                {localToastVisible && (
                    <Animated.View pointerEvents="none" style={[styles.localToast as ViewStyle, { opacity: localToastAnim }]}>
                        <Ionicons name="checkmark-circle" size={16} color="#fff" style={{ marginRight: 6 }} />
                        <Text style={styles.localToastText as TextStyle}>{t('common.copied')}</Text>
                    </Animated.View>
                )}
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
    copyMenuBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    copyMenuContainer: {
        position: 'absolute',
        alignItems: 'center',
    },
    copyMenuButton: {
        backgroundColor: '#232325',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
    },
    copyMenuText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '500',
    },
    copyMenuArrow: {
        width: 8,
        height: 8,
        backgroundColor: '#232325',
        transform: [{ rotate: '45deg' }],
        marginTop: -4,
    },
    localToast: {
        position: 'absolute',
        bottom: Platform.OS === 'ios' ? 100 : 80,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.75)',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
    },
    localToastText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '500',
    },
}));
