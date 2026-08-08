import React from 'react';
import {
    View,
    Text,
    Platform,
    Pressable,
    Modal as RNModal,
    TouchableWithoutFeedback,
    Animated,
    ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { imageViewer } from '@/sync/imageViewer';
import {
    useGallery,
    setLastSeen,
    useResolvedScreenshotUri,
    type ScreenshotEntry,
} from '@/sync/screenshotGallery';

const THUMB_SIZE = 100;

/**
 * 底部抽屉式「截图图库」面板（带外图库的可见 UI）。
 *
 * 数据源是 MMKV 里按 sessionId 隔离的截图列表（手动截图 + AI 截图都会写入），
 * 用 `useGallery` 响应式订阅，新图自动出现。交互约定：
 *   - 点缩略图本体 = 全屏查看（imageViewer）
 *   - 缩略图右下角的「+」按钮 = 把这张图挂到输入栏（onAttach）然后关闭抽屉
 * 打开抽屉即把「已见到的最新 createdAt」写回 MMKV，清除入口红点。
 *
 * BottomSheet 范式照搬自 dev/session-composer.tsx：iOS 用原生 formSheet，
 * Android 用透明 Modal + 上滑动画 + 背景点击关闭。
 */

// ---- BottomSheet（与 session-composer.tsx 同款范式）----
function BottomSheet({
    visible,
    onClose,
    children,
}: {
    visible: boolean;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const fadeAnim = React.useRef(new Animated.Value(0)).current;
    const slideAnim = React.useRef(new Animated.Value(300)).current;
    const useNativeDriver = Platform.OS !== 'web';

    React.useEffect(() => {
        if (Platform.OS === 'ios') {
            return;
        }
        if (visible) {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver }),
                Animated.spring(slideAnim, { toValue: 0, damping: 25, stiffness: 300, useNativeDriver }),
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver }),
                Animated.timing(slideAnim, { toValue: 300, duration: 200, useNativeDriver }),
            ]).start();
        }
    }, [visible, fadeAnim, slideAnim, useNativeDriver]);

    if (Platform.OS === 'ios') {
        return (
            <RNModal
                visible={visible}
                animationType="slide"
                presentationStyle="formSheet"
                onRequestClose={onClose}
            >
                <View style={[sheetStyles.iosContainer, { backgroundColor: theme.colors.header.background }]}>
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                    <View style={{ height: safeArea.bottom }} />
                </View>
            </RNModal>
        );
    }

    return (
        <RNModal
            visible={visible}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            <View style={sheetStyles.overlay}>
                <TouchableWithoutFeedback onPress={onClose}>
                    <Animated.View style={[sheetStyles.backdrop, { opacity: fadeAnim }]} />
                </TouchableWithoutFeedback>
                <Animated.View
                    style={[
                        sheetStyles.sheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                            transform: [{ translateY: slideAnim }],
                        },
                    ]}
                >
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                </Animated.View>
            </View>
        </RNModal>
    );
}

// ---- 单个缩略图格 ----
const GalleryCell = React.memo(function GalleryCell({
    entry,
    onView,
    onAttach,
}: {
    entry: ScreenshotEntry;
    onView: (entry: ScreenshotEntry) => void;
    onAttach: (entry: ScreenshotEntry) => void;
}) {
    const { theme } = useUnistyles();
    const resolvedUri = useResolvedScreenshotUri(entry.uri);
    const resolvedEntry = React.useMemo(
        () => resolvedUri ? { ...entry, uri: resolvedUri } : null,
        [entry, resolvedUri],
    );
    const handleView = React.useCallback(() => {
        if (resolvedEntry) {
            onView(resolvedEntry);
        }
    }, [onView, resolvedEntry]);
    const handleAttach = React.useCallback(() => {
        if (resolvedEntry) {
            onAttach(resolvedEntry);
        }
    }, [onAttach, resolvedEntry]);

    const sourceLabel = entry.source === 'ai'
        ? t('components.screenshotGallery.sourceAi')
        : t('components.screenshotGallery.sourceManual');
    const targetIcon = entry.target === 'browser' ? 'globe-outline' : 'desktop-outline';

    return (
        <View style={styles.cell}>
            <Pressable
                onPress={handleView}
                disabled={!resolvedEntry}
                style={(p) => [styles.thumbPressable, p.pressed && styles.cellPressed]}
            >
                <Image
                    style={[{ width: THUMB_SIZE, height: THUMB_SIZE }, styles.thumb]}
                    source={resolvedUri ? { uri: resolvedUri } : undefined}
                    contentFit="cover"
                />
                {/* 左上角来源徽标 */}
                <View style={styles.sourceBadge}>
                    <Ionicons name={targetIcon} size={11} color={theme.colors.button.primary.tint} />
                    <Text style={styles.sourceBadgeText} numberOfLines={1}>{sourceLabel}</Text>
                </View>
                {/* note 角标 */}
                {!!entry.note && (
                    <View style={styles.noteBadge}>
                        <Text style={styles.noteBadgeText} numberOfLines={1}>{entry.note}</Text>
                    </View>
                )}
            </Pressable>
            {/* 右下角「+」挂到输入栏 */}
            <Pressable
                accessibilityLabel={t('components.screenshotGallery.attach')}
                onPress={handleAttach}
                disabled={!resolvedEntry}
                hitSlop={6}
                style={(p) => [styles.attachButton, p.pressed && styles.attachButtonPressed]}
            >
                <Ionicons name="add" size={18} color={theme.colors.button.primary.tint} />
            </Pressable>
        </View>
    );
});

function ScreenshotGalleryDrawerImpl({
    visible,
    onClose,
    sessionId,
    onAttach,
}: {
    visible: boolean;
    onClose: () => void;
    sessionId: string;
    onAttach: (entry: ScreenshotEntry) => void;
}) {
    const { theme } = useUnistyles();
    const entries = useGallery(sessionId);

    // 打开抽屉即把红点清掉：记录当前最新 createdAt 为「已见到」。
    React.useEffect(() => {
        if (visible && entries.length > 0) {
            setLastSeen(sessionId, entries[0].createdAt);
        }
    }, [visible, sessionId, entries]);

    const handleView = React.useCallback((entry: ScreenshotEntry) => {
        imageViewer.open({ uri: entry.uri, filename: `screenshot-${entry.id}.png` });
    }, []);

    const handleAttach = React.useCallback((entry: ScreenshotEntry) => {
        onAttach(entry);
        onClose();
    }, [onAttach, onClose]);

    return (
        <BottomSheet visible={visible} onClose={onClose}>
            <View style={styles.container}>
                <Text style={styles.title}>{t('components.screenshotGallery.title')}</Text>
                {entries.length === 0 ? (
                    <View style={styles.emptyBox}>
                        <Ionicons name="images-outline" size={36} color={theme.colors.textSecondary} />
                        <Text style={styles.emptyText}>{t('components.screenshotGallery.empty')}</Text>
                        <Text style={styles.emptyHint}>{t('components.screenshotGallery.emptyHint')}</Text>
                    </View>
                ) : (
                    <ScrollView style={styles.scroll} contentContainerStyle={styles.grid}>
                        {entries.map((entry) => (
                            <GalleryCell
                                key={entry.id}
                                entry={entry}
                                onView={handleView}
                                onAttach={handleAttach}
                            />
                        ))}
                    </ScrollView>
                )}
            </View>
        </BottomSheet>
    );
}

export const ScreenshotGalleryDrawer = React.memo(ScreenshotGalleryDrawerImpl);

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    title: {
        fontSize: 18,
        color: theme.colors.text,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default('semiBold'),
    },
    scroll: {
        maxHeight: 360,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingBottom: 8,
    },
    cell: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
    },
    thumbPressable: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: 12,
        overflow: 'hidden',
    },
    cellPressed: {
        opacity: 0.7,
    },
    thumb: {
        borderRadius: 12,
        backgroundColor: theme.colors.input.background,
    },
    sourceBadge: {
        position: 'absolute',
        top: 4,
        left: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        maxWidth: THUMB_SIZE - 8,
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
    },
    sourceBadgeText: {
        fontSize: 10,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    noteBadge: {
        position: 'absolute',
        bottom: 4,
        left: 4,
        right: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
    },
    noteBadgeText: {
        fontSize: 10,
        color: theme.colors.button.primary.tint,
        ...Typography.default(),
    },
    attachButton: {
        position: 'absolute',
        bottom: 4,
        right: 4,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    attachButtonPressed: {
        opacity: 0.7,
    },
    emptyBox: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 48,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    emptyHint: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

const sheetStyles = {
    iosContainer: {
        flex: 1,
    } as const,
    handleRow: {
        alignItems: 'center' as const,
        paddingTop: 10,
        paddingBottom: 6,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        opacity: 0.3,
    },
    overlay: {
        flex: 1,
        justifyContent: 'flex-end' as const,
    },
    backdrop: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'black',
        opacity: 0.4,
    },
    sheet: {
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        maxHeight: '70%' as const,
    },
};
