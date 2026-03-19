/**
 * DuplicateSheet Component
 *
 * A bottom sheet that displays user messages from a Claude session.
 * Users can select a message to fork/duplicate the conversation from that point.
 * The selected message and everything after it will be removed in the new session.
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
    ListRenderItemInfo,
    Pressable,
    PanResponder,
    useWindowDimensions,
    ViewStyle,
    TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Text } from './StyledText';
import { layout } from './layout';
import { hapticsLight } from './haptics';
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

interface CopyMenuState {
    x: number;
    y: number;
    content: string;
    index: number;
    isLong: boolean;
}

const ANIMATION_DURATION = 250;
const MIN_HEIGHT_RATIO = 0.3;
const MAX_HEIGHT_RATIO = 0.9;
const DEFAULT_HEIGHT_RATIO = 0.7;

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
    const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());
    const [truncatedIndices, setTruncatedIndices] = useState<Set<number>>(new Set());
    const [copyMenu, setCopyMenu] = useState<CopyMenuState | null>(null);
    const copyMenuRef = useRef<CopyMenuState | null>(null);
    const copyMenuAnim = useRef(new Animated.Value(0)).current;
    const menuAnimStartedRef = useRef(false);
    const [copyMenuWidth, setCopyMenuWidth] = useState(0);
    const [localToastVisible, setLocalToastVisible] = useState(false);
    const localToastAnim = useRef(new Animated.Value(0)).current;
    const currentHeightRef = useRef(windowHeight * DEFAULT_HEIGHT_RATIO);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(300)).current;
    const dragStartY = useRef(0);
    const dragStartHeight = useRef(0);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pressInAtRef = useRef(0);
    const touchStartYRef = useRef(0);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            setExpandedIndices(new Set());
            setTruncatedIndices(new Set());
            setCopyMenu(null);
            copyMenuRef.current = null;
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
        return () => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        };
    }, []);

    const cancelLongPress = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const showCopyMenu = useCallback((menu: CopyMenuState) => {
        copyMenuRef.current = menu;
        copyMenuAnim.setValue(0);
        menuAnimStartedRef.current = false;
        setCopyMenu(menu);
        // Animation starts in onLayout after width is measured to avoid jitter
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

    const handleMessageSelect = (uuid: string) => {
        setSelectedUuid(uuid);
    };

    const handleToggleExpanded = useCallback((index: number) => {
        setExpandedIndices((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

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

    const reversedMessages = useMemo(() => messages ? [...messages].reverse() : [], [messages]);

    const flatListExtraData = useMemo(
        () => ({ truncatedIndices, expandedIndices, selectedUuid }),
        [truncatedIndices, expandedIndices, selectedUuid],
    );

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

                    {/* Content - using inverted FlatList to avoid scroll flash */}
                    {loading ? (
                        <View style={[styles.content as ViewStyle, styles.loadingContainer as ViewStyle]}>
                            <ActivityIndicator size="small" color="#8E8E93" />
                            <Text style={styles.loadingText as TextStyle}>{t('common.loading')}</Text>
                        </View>
                    ) : messages && messages.length > 0 ? (
                        <FlatList
                            data={reversedMessages}
                            inverted={true}
                            extraData={flatListExtraData}
                            style={styles.content as ViewStyle}
                            contentContainerStyle={styles.contentContainer as ViewStyle}
                            onScroll={cancelLongPress}
                            scrollEventThrottle={16}
                            onScrollBeginDrag={hideCopyMenu}
                            showsVerticalScrollIndicator={false}
                            keyExtractor={(msg, index) => `${msg.uuid}-${index}`}
                            renderItem={({ item: msg, index }: ListRenderItemInfo<ClaudeUserMessageWithUuid>) => {
                                const isExpanded = expandedIndices.has(index);
                                const isLong = truncatedIndices.has(index);

                                return (
                                    <View
                                        style={styles.messageItem as ViewStyle}
                                        onTouchStart={(e) => {
                                            pressInAtRef.current = Date.now();
                                            touchStartYRef.current = e.nativeEvent.pageY;
                                            const { pageX, pageY } = e.nativeEvent;
                                            cancelLongPress();
                                            longPressTimerRef.current = setTimeout(() => {
                                                longPressTimerRef.current = null;
                                                hapticsLight();
                                                showCopyMenu({ x: pageX, y: pageY, content: msg.content, index, isLong });
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
                                            handleMessageSelect(msg.uuid);
                                        }}
                                    >
                                        <View style={styles.messageContent as ViewStyle}>
                                            <Text
                                                style={styles.messageText as TextStyle}
                                                numberOfLines={isExpanded ? undefined : 1}
                                            >
                                                {msg.content}
                                            </Text>
                                            {/* Hidden text without numberOfLines for accurate line measurement */}
                                            {!isExpanded && !isLong && (
                                                <Text
                                                    style={styles.measureText as TextStyle}
                                                    pointerEvents="none"
                                                    onTextLayout={(e) => {
                                                        if (e.nativeEvent.lines.length > 1) {
                                                            setTruncatedIndices(prev => {
                                                                if (prev.has(index)) return prev;
                                                                const next = new Set(prev);
                                                                next.add(index);
                                                                return next;
                                                            });
                                                        }
                                                    }}
                                                >
                                                    {msg.content}
                                                </Text>
                                            )}
                                            {msg.timestamp && (
                                                <Text style={styles.messageTime as TextStyle}>
                                                    {formatRelativeTime(msg.timestamp)}
                                                </Text>
                                            )}
                                        </View>
                                        {selectedUuid === msg.uuid ? (
                                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                                        ) : (
                                            <View style={styles.radioUnselected as ViewStyle} />
                                        )}
                                    </View>
                                );
                            }}
                        />
                    ) : (
                        <View style={[styles.content as ViewStyle, styles.emptyContainer as ViewStyle]}>
                            <Ionicons name="chatbubble-outline" size={48} color="#8E8E93" />
                            <Text style={styles.emptyText as TextStyle}>{t('duplicate.noMessages')}</Text>
                        </View>
                    )}

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
                            onLayout={(e) => {
                                setCopyMenuWidth(e.nativeEvent.layout.width);
                                if (!menuAnimStartedRef.current) {
                                    menuAnimStartedRef.current = true;
                                    Animated.spring(copyMenuAnim, {
                                        toValue: 1,
                                        damping: 15,
                                        stiffness: 300,
                                        useNativeDriver: true,
                                    }).start();
                                }
                            }}
                        >
                            <View style={styles.copyMenuRow as ViewStyle}>
                                <Pressable
                                    style={styles.copyMenuButton as ViewStyle}
                                    onPress={() => {
                                        Clipboard.setStringAsync(copyMenu.content);
                                        hapticsLight();
                                        showLocalToast();
                                        hideCopyMenu();
                                    }}
                                >
                                    <Text style={styles.copyMenuText as TextStyle}>{t('common.copy')}</Text>
                                </Pressable>
                                {copyMenu.isLong && (
                                    <>
                                        <View style={styles.copyMenuDivider as ViewStyle} />
                                        <Pressable
                                            style={styles.copyMenuButton as ViewStyle}
                                            onPress={() => {
                                                handleToggleExpanded(copyMenu.index);
                                                hideCopyMenu();
                                            }}
                                        >
                                            <Text style={styles.copyMenuText as TextStyle}>
                                                {expandedIndices.has(copyMenu.index) ? t('duplicate.collapseText') : t('duplicate.expandText')}
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                            </View>
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
    radioUnselected: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: theme.colors.divider,
    },
    messageText: {
        fontSize: 15,
        color: theme.colors.text,
        lineHeight: 20,
    },
    measureText: {
        fontSize: 15,
        lineHeight: 20,
        position: 'absolute',
        opacity: 0,
        left: 0,
        right: 0,
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
    copyMenuRow: {
        flexDirection: 'row',
        backgroundColor: '#232325',
        borderRadius: 8,
        overflow: 'hidden',
        zIndex: 1,
    },
    copyMenuButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    copyMenuDivider: {
        width: 0.5,
        backgroundColor: 'rgba(255,255,255,0.2)',
        alignSelf: 'stretch',
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
