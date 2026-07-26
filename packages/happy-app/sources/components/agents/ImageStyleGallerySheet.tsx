import * as React from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ImageAgentStylePreset } from './imageAgentPrompt';
import { IMAGE_AGENT_STYLE_CATEGORIES, getImageAgentStyleLabel } from './imageAgentPrompt';
import { getImageStylePreviewAsset } from './imageStylePreviewAssets';
import {
    IMAGE_STYLE_GALLERY_COLUMN_GAP,
    createImageStyleGalleryColumns,
    getImageStyleGalleryColumnCount,
    getImageStyleGalleryDesktopSize,
    getImageStyleGallerySheetHeight,
    getImageStylePreviewHeight,
} from './imageStyleGalleryLayout';
import { IMAGE_STYLE_PREVIEW_MANIFEST } from './imageStylePreviewManifest';

type Props = {
    visible: boolean;
    styles: ImageAgentStylePreset[];
    selectedStyleIds: string[];
    canCreateCustomStyle?: boolean;
    onCreateCustomStyle?: () => void;
    onDeleteCustomStyle?: (style: ImageAgentStylePreset) => void;
    onRetryCustomStyleAnalysis?: (style: ImageAgentStylePreset) => void;
    onPickImages?: () => void;
    onToggle: (style: ImageAgentStylePreset) => void;
    onClose: () => void;
};

const ALL_CATEGORY_ID = 'all';
const SHEET_HORIZONTAL_PADDING = 28;

function StylePreview({ style, cardWidth }: { style: ImageAgentStylePreset; cardWidth: number }) {
    const customReference = style.referenceImages?.[0];
    const source = customReference ? { uri: customReference.uri } : getImageStylePreviewAsset(style.id);
    const preview = IMAGE_STYLE_PREVIEW_MANIFEST[style.id];
    const previewHeight = preview
        ? getImageStylePreviewHeight(preview, cardWidth)
        : customReference && customReference.width > 0 && customReference.height > 0
            ? Math.max(140, Math.min(280, cardWidth * (customReference.height / customReference.width)))
            : 140;

    if (!source) {
        return (
            <View style={[galleryStyles.previewFallback, { height: previewHeight }]}>
                <Ionicons name="image-outline" size={24} color={galleryStyles.previewFallbackIcon.color} />
            </View>
        );
    }

    return (
        <View style={[galleryStyles.preview, { height: previewHeight }]}>
            <Image source={source} resizeMode="cover" style={galleryStyles.previewImage} />
        </View>
    );
}

function getCustomStyleStatusKey(status: ImageAgentStylePreset['analysisStatus']) {
    if (status === 'prompt-ready') return 'agents.customImageStylePromptReady';
    if (status === 'analyzing') return 'agents.customImageStyleAnalyzing';
    if (status === 'failed') return 'agents.customImageStyleFailed';
    return 'agents.customImageStyleReferenceReady';
}

function getCustomStyleStatusIcon(status: ImageAgentStylePreset['analysisStatus']): keyof typeof Ionicons.glyphMap {
    if (status === 'prompt-ready') return 'checkmark-circle-outline';
    if (status === 'analyzing') return 'time-outline';
    if (status === 'failed') return 'alert-circle-outline';
    return 'image-outline';
}

function getCustomStyleStatusLine(style: ImageAgentStylePreset, now: number) {
    if (style.analysisStatus === 'analyzing' && style.customUpdatedAt) {
        return t('agents.customImageStyleElapsed', { time: formatDuration(now - style.customUpdatedAt) });
    }
    if (style.analysisStatus === 'prompt-ready' && style.customCreatedAt && style.customAnalyzedAt) {
        return t('agents.customImageStyleCompletedIn', { time: formatDuration(style.customAnalyzedAt - style.customCreatedAt) });
    }
    if (style.analysisStatus === 'failed' && style.customUpdatedAt) {
        return t('agents.customImageStyleFailedAt', { time: formatClock(style.customUpdatedAt) });
    }
    if (style.customCreatedAt) {
        return t('agents.customImageStyleCreatedAt', { time: formatClock(style.customCreatedAt) });
    }
    return t(getCustomStyleStatusKey(style.analysisStatus));
}

function getCustomStyleProgressPercent(style: ImageAgentStylePreset, now: number) {
    const startedAt = style.customUpdatedAt ?? now;
    const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    return Math.min(92, 12 + elapsedSeconds * 2);
}

function formatDuration(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return t('agents.customImageStyleSeconds', { count: seconds });
    return t('agents.customImageStyleMinutesSeconds', { minutes, seconds });
}

function formatClock(timestamp: number) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

export const ImageStyleGallerySheet = React.memo(function ImageStyleGallerySheet(props: Props) {
    const safeArea = useSafeAreaInsets();
    const windowDimensions = useWindowDimensions();
    const styles = galleryStyles;
    const [categoryId, setCategoryId] = React.useState(ALL_CATEGORY_ID);
    const [promptPreviewStyle, setPromptPreviewStyle] = React.useState<ImageAgentStylePreset | null>(null);
    const [now, setNow] = React.useState(Date.now());
    const isDesktopWeb = Platform.OS === 'web' && windowDimensions.width >= 900;
    const desktopSize = React.useMemo(
        () => getImageStyleGalleryDesktopSize(windowDimensions.width, windowDimensions.height),
        [windowDimensions.height, windowDimensions.width],
    );
    const columnCount = getImageStyleGalleryColumnCount(windowDimensions.width);
    const galleryWidth = isDesktopWeb ? desktopSize.width : windowDimensions.width;
    const cardWidth = Math.max(
        140,
        Math.floor((
            galleryWidth
            - SHEET_HORIZONTAL_PADDING
            - IMAGE_STYLE_GALLERY_COLUMN_GAP * (columnCount - 1)
        ) / columnCount),
    );
    const sheetHeight = isDesktopWeb
        ? desktopSize.height
        : getImageStyleGallerySheetHeight(windowDimensions.height);
    const visibleCategoryIds = React.useMemo(() => new Set(props.styles.map((style) => style.categoryId)), [props.styles]);
    const selectedStyleIds = React.useMemo(() => new Set(props.selectedStyleIds), [props.selectedStyleIds]);
    const categoryOptions = React.useMemo(
        () => IMAGE_AGENT_STYLE_CATEGORIES.filter((category) => visibleCategoryIds.has(category.id)),
        [visibleCategoryIds],
    );
    const filteredStyles = React.useMemo(
        () => categoryId === ALL_CATEGORY_ID
            ? props.styles
            : props.styles.filter((style) => style.categoryId === categoryId),
        [categoryId, props.styles],
    );
    const styleColumns = React.useMemo(
        () => createImageStyleGalleryColumns(
            filteredStyles,
            cardWidth,
            (style) => IMAGE_STYLE_PREVIEW_MANIFEST[style.id],
            columnCount,
        ),
        [cardWidth, columnCount, filteredStyles],
    );

    React.useEffect(() => {
        if (categoryId !== ALL_CATEGORY_ID && !visibleCategoryIds.has(categoryId)) {
            setCategoryId(ALL_CATEGORY_ID);
        }
    }, [categoryId, visibleCategoryIds]);

    React.useEffect(() => {
        if (!props.visible || !props.styles.some((style) => style.custom && style.analysisStatus === 'analyzing')) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [props.visible, props.styles]);

    React.useEffect(() => {
        if (!props.visible || !isDesktopWeb || typeof window === 'undefined') return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            props.onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isDesktopWeb, props.onClose, props.visible]);

    const onPressPinAction = React.useCallback(() => {
        if (props.canCreateCustomStyle) {
            props.onCreateCustomStyle?.();
            return;
        }
        props.onPickImages?.();
    }, [props.canCreateCustomStyle, props.onCreateCustomStyle, props.onPickImages]);

    const renderStyle = React.useCallback((style: ImageAgentStylePreset) => {
        const selected = selectedStyleIds.has(style.id);
        const customStatusLine = style.custom ? getCustomStyleStatusLine(style, now) : undefined;
        const promptPreviewAvailable = style.custom && style.analysisStatus === 'prompt-ready' && !!style.customPromptContent?.trim();
        return (
            <View key={style.id} style={styles.cell}>
                <Pressable
                    onPress={() => props.onToggle(style)}
                    accessibilityRole="checkbox"
                    accessibilityLabel={getImageAgentStyleLabel(style)}
                    accessibilityState={{ checked: selected }}
                    style={({ pressed }) => [
                        styles.card,
                        selected && styles.cardSelected,
                        pressed && styles.pressed,
                    ]}
                >
                    <StylePreview style={style} cardWidth={cardWidth} />
                    <View style={styles.cardCopy}>
                        <Text style={styles.cardTitle} numberOfLines={2}>{getImageAgentStyleLabel(style)}</Text>
                        <Text style={styles.cardMeta} numberOfLines={1}>
                            {style.custom ? t(getCustomStyleStatusKey(style.analysisStatus)) : style.categoryLabel}
                            {' · '}
                            {style.templateLabel}
                        </Text>
                        <Text style={styles.cardHint} numberOfLines={2}>{style.promptHint}</Text>
                        {customStatusLine && (
                            <Text style={styles.cardStatusLine} numberOfLines={1}>
                                {customStatusLine}
                            </Text>
                        )}
                        {style.custom && style.analysisStatus === 'analyzing' && (
                            <View style={styles.progressTrack}>
                                <View style={[styles.progressFill, { width: `${getCustomStyleProgressPercent(style, now)}%` }]} />
                            </View>
                        )}
                        {style.custom && (
                            <Pressable
                                onPress={(event) => {
                                    event.stopPropagation();
                                    setPromptPreviewStyle(style);
                                }}
                                disabled={!promptPreviewAvailable && style.analysisStatus !== 'failed' && style.analysisStatus !== 'analyzing'}
                                style={({ pressed }) => [
                                    styles.promptPreviewButton,
                                    !promptPreviewAvailable && style.analysisStatus !== 'failed' && style.analysisStatus !== 'analyzing' && styles.promptPreviewButtonDisabled,
                                    pressed && styles.pressed,
                                ]}
                            >
                                <Ionicons
                                    name={promptPreviewAvailable ? 'document-text-outline' : style.analysisStatus === 'failed' ? 'alert-circle-outline' : 'time-outline'}
                                    size={13}
                                    color={styles.promptPreviewText.color}
                                />
                                <Text style={styles.promptPreviewText} numberOfLines={1}>
                                    {promptPreviewAvailable
                                        ? t('agents.customImageStyleViewPrompt')
                                        : style.analysisStatus === 'failed'
                                            ? t('agents.customImageStyleViewFailure')
                                            : t('agents.customImageStyleViewProgress')}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                    <View style={styles.cardFooter}>
                        <Text style={styles.cardAction} numberOfLines={1}>
                            {selected ? t('agents.imageEffectSelected') : t('agents.imageEffectApply')}
                        </Text>
                        <Ionicons
                            name={selected ? 'checkmark-circle' : 'arrow-forward-circle-outline'}
                            size={16}
                            color={selected ? styles.selectedIcon.color : styles.cardAction.color}
                        />
                    </View>
                    {style.custom && props.onDeleteCustomStyle && (
                        <Pressable
                            onPress={(event) => {
                                event.stopPropagation();
                                props.onDeleteCustomStyle?.(style);
                            }}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('agents.customImageStyleDeleteAction')}
                            style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                        >
                            <Ionicons name="trash-outline" size={15} color={styles.deleteIcon.color} />
                        </Pressable>
                    )}
                    {style.custom && (
                        <View style={styles.statusPill}>
                            <Ionicons
                                name={getCustomStyleStatusIcon(style.analysisStatus)}
                                size={12}
                                color={styles.statusPillText.color}
                            />
                            <Text style={styles.statusPillText} numberOfLines={1}>
                                {t(getCustomStyleStatusKey(style.analysisStatus))}
                            </Text>
                        </View>
                    )}
                    {style.custom && style.analysisStatus === 'failed' && props.onRetryCustomStyleAnalysis && (
                        <Pressable
                            onPress={(event) => {
                                event.stopPropagation();
                                props.onRetryCustomStyleAnalysis?.(style);
                            }}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('agents.customImageStyleRetryAction')}
                            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                        >
                            <Ionicons name="refresh-outline" size={15} color={styles.retryIcon.color} />
                        </Pressable>
                    )}
                </Pressable>
            </View>
        );
    }, [cardWidth, now, props, selectedStyleIds, styles]);

    const categoryChips = (
        <>
            <Pressable
                onPress={() => setCategoryId(ALL_CATEGORY_ID)}
                accessibilityRole="button"
                accessibilityState={{ selected: categoryId === ALL_CATEGORY_ID }}
                style={({ pressed }) => [
                    styles.categoryChip,
                    categoryId === ALL_CATEGORY_ID && styles.categoryChipSelected,
                    pressed && styles.pressed,
                ]}
            >
                <Text
                    style={[
                        styles.categoryLabel,
                        categoryId === ALL_CATEGORY_ID && styles.categoryLabelSelected,
                    ]}
                    numberOfLines={1}
                >
                    {t('agents.imageEffectAll')}
                </Text>
            </Pressable>
            {categoryOptions.map((category) => {
                const selected = categoryId === category.id;
                return (
                    <Pressable
                        key={category.id}
                        onPress={() => setCategoryId(category.id)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        style={({ pressed }) => [
                            styles.categoryChip,
                            selected && styles.categoryChipSelected,
                            pressed && styles.pressed,
                        ]}
                    >
                        <View style={[styles.categoryDot, { backgroundColor: category.accent }]} />
                        <Text
                            style={[
                                styles.categoryLabel,
                                selected && styles.categoryLabelSelected,
                            ]}
                            numberOfLines={1}
                        >
                            {category.label}
                        </Text>
                        <Text style={styles.categoryCount} numberOfLines={1}>{category.count}</Text>
                    </Pressable>
                );
            })}
        </>
    );

    return (
        <Modal visible={props.visible} transparent animationType={isDesktopWeb ? 'fade' : 'slide'} onRequestClose={props.onClose}>
            <View
                style={[
                    styles.modalRoot,
                    isDesktopWeb && styles.desktopModalRoot,
                    { width: windowDimensions.width, height: windowDimensions.height },
                ]}
            >
                <Pressable style={styles.scrim} onPress={props.onClose} />
                <View
                    testID="image-style-gallery-dialog"
                    role="dialog"
                    style={[
                        styles.sheet,
                        isDesktopWeb && styles.desktopDialog,
                        {
                            width: isDesktopWeb ? desktopSize.width : undefined,
                            height: sheetHeight,
                            paddingBottom: safeArea.bottom + 12,
                        },
                    ]}
                >
                    {!isDesktopWeb && <View style={styles.handle} />}
                    <View style={styles.header}>
                        <View style={styles.headerCopy}>
                            <Text style={styles.title} numberOfLines={1}>{t('agents.imageEffectGalleryTitle')}</Text>
                            <Text style={styles.subtitle} numberOfLines={1}>{t('agents.imageEffectGallerySubtitle')}</Text>
                        </View>
                        <Pressable
                            onPress={props.onClose}
                            hitSlop={8}
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
                        >
                            <Text style={styles.doneText}>{t('common.ok')}</Text>
                        </Pressable>
                        <Pressable
                            onPress={props.onClose}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('devTools.close')}
                            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                        >
                            <Ionicons name="close" size={18} color={styles.closeIcon.color} />
                        </Pressable>
                    </View>

                    <Pressable
                        onPress={onPressPinAction}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                            styles.pinAction,
                            !props.canCreateCustomStyle && styles.pinActionDisabled,
                            pressed && styles.pinActionPressed,
                        ]}
                    >
                        <View style={styles.pinIcon}>
                            <Ionicons
                                name={props.canCreateCustomStyle ? 'sparkles-outline' : 'images-outline'}
                                size={18}
                                color={props.canCreateCustomStyle ? styles.pinIconEnabled.color : styles.pinIconDisabled.color}
                            />
                        </View>
                        <View style={styles.pinCopy}>
                            <Text style={[styles.pinTitle, !props.canCreateCustomStyle && styles.pinTitleDisabled]} numberOfLines={1}>
                                {props.canCreateCustomStyle ? t('agents.customImageStyleCreateAction') : t('agents.customImageStyleNeedPhoto')}
                            </Text>
                            <Text style={styles.pinSubtitle} numberOfLines={1}>
                                {props.canCreateCustomStyle ? t('agents.customImageStyleCreateHint') : t('agents.customImageStyleNeedPhotoHint')}
                            </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={17} color={styles.pinChevron.color} />
                    </Pressable>

                    {isDesktopWeb ? (
                        <View
                            testID="image-style-gallery-categories"
                            style={[styles.categoryScroller, styles.categoryContent, styles.desktopCategoryContent]}
                        >
                            {categoryChips}
                        </View>
                    ) : (
                        <ScrollView
                            horizontal
                            style={styles.categoryScroller}
                            contentContainerStyle={styles.categoryContent}
                            showsHorizontalScrollIndicator
                        >
                            {categoryChips}
                        </ScrollView>
                    )}

                    <ScrollView
                        style={styles.list}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <View style={styles.masonryColumns}>
                            {styleColumns.map((column, columnIndex) => (
                                <View key={columnIndex} style={styles.masonryColumn}>
                                    {column.map(renderStyle)}
                                </View>
                            ))}
                        </View>
                    </ScrollView>
                </View>
                {promptPreviewStyle && (
                    <Modal
                        visible={true}
                        transparent
                        animationType="fade"
                        onRequestClose={() => setPromptPreviewStyle(null)}
                    >
                        <View style={styles.promptModalRoot}>
                            <Pressable style={styles.promptModalScrim} onPress={() => setPromptPreviewStyle(null)} />
                            <View style={styles.promptModalCard}>
                                <View style={styles.promptModalHeader}>
                                    <View style={styles.promptModalTitleWrap}>
                                        <Text style={styles.promptModalTitle} numberOfLines={1}>
                                            {getImageAgentStyleLabel(promptPreviewStyle)}
                                        </Text>
                                        <Text style={styles.promptModalSubtitle} numberOfLines={1}>
                                            {getCustomStyleStatusLine(promptPreviewStyle, now)}
                                        </Text>
                                    </View>
                                    <Pressable
                                        onPress={() => setPromptPreviewStyle(null)}
                                        hitSlop={8}
                                        style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                                    >
                                        <Ionicons name="close" size={18} color={styles.closeIcon.color} />
                                    </Pressable>
                                </View>
                                <ScrollView style={styles.promptModalBody} showsVerticalScrollIndicator={false}>
                                    <Text style={styles.promptModalSectionTitle}>
                                        {promptPreviewStyle.analysisStatus === 'prompt-ready'
                                            ? t('agents.customImageStylePromptSection')
                                            : promptPreviewStyle.analysisStatus === 'failed'
                                                ? t('agents.customImageStyleFailureSection')
                                                : t('agents.customImageStyleProgressSection')}
                                    </Text>
                                    <Text style={styles.promptModalText}>
                                        {promptPreviewStyle.analysisStatus === 'prompt-ready'
                                            ? promptPreviewStyle.customPromptContent?.trim()
                                            : promptPreviewStyle.analysisStatus === 'failed'
                                                ? promptPreviewStyle.analysisError || t('agents.customImageStyleAnalysisFailed')
                                                : t('agents.customImageStyleProgressMessage')}
                                    </Text>
                                    {!!promptPreviewStyle.customNegativePrompt?.trim() && (
                                        <>
                                            <Text style={styles.promptModalSectionTitle}>
                                                {t('agents.customImageStyleNegativeSection')}
                                            </Text>
                                            <Text style={styles.promptModalText}>
                                                {promptPreviewStyle.customNegativePrompt.trim()}
                                            </Text>
                                        </>
                                    )}
                                </ScrollView>
                            </View>
                        </View>
                    </Modal>
                )}
            </View>
        </Modal>
    );
});

const galleryStyles = StyleSheet.create((theme) => ({
    modalRoot: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    desktopModalRoot: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    scrim: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.48)',
    },
    sheet: {
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingTop: 8,
        paddingHorizontal: 14,
    },
    desktopDialog: {
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        ...Platform.select({
            web: {
                boxShadow: '0 24px 70px rgba(0, 0, 0, 0.34)',
            },
            default: {},
        }),
    },
    handle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.divider,
        marginBottom: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 10,
    },
    headerCopy: {
        flex: 1,
    },
    pinAction: {
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginBottom: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.button.primary.background,
    },
    pinActionDisabled: {
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    pinActionPressed: {
        opacity: 0.82,
    },
    pinIcon: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
    },
    pinIconEnabled: {
        color: theme.colors.button.primary.tint,
    },
    pinIconDisabled: {
        color: theme.colors.textSecondary,
    },
    pinCopy: {
        flex: 1,
    },
    pinTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.button.primary.tint,
    },
    pinTitleDisabled: {
        color: theme.colors.text,
    },
    pinSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    pinChevron: {
        color: theme.colors.textSecondary,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    closeButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    doneButton: {
        minWidth: 54,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface,
    },
    doneText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    closeIcon: {
        color: theme.colors.textSecondary,
    },
    list: {
        flex: 1,
    },
    listContent: {
        paddingBottom: 8,
    },
    categoryScroller: {
        flexGrow: 0,
        overflow: 'visible',
        marginBottom: 12,
    },
    categoryContent: {
        flexDirection: 'row',
        gap: 8,
        paddingRight: 24,
        paddingVertical: 2,
    },
    desktopCategoryContent: {
        flexWrap: 'wrap',
        paddingRight: 0,
        maxHeight: 140,
        overflow: 'hidden',
    },
    categoryChip: {
        minHeight: 38,
        borderRadius: 19,
        paddingHorizontal: 12,
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    categoryChipSelected: {
        borderColor: theme.colors.accent,
    },
    categoryDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    categoryLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        maxWidth: 156,
    },
    categoryLabelSelected: {
        color: theme.colors.text,
    },
    categoryCount: {
        ...Typography.mono(),
        fontSize: 11,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    masonryColumns: {
        flexDirection: 'row',
        gap: IMAGE_STYLE_GALLERY_COLUMN_GAP,
    },
    masonryColumn: {
        flex: 1,
    },
    cell: {
        paddingBottom: 12,
    },
    card: {
        width: '100%',
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    cardSelected: {
        borderColor: theme.colors.accent,
    },
    pressed: {
        opacity: 0.76,
    },
    preview: {
        overflow: 'hidden',
        backgroundColor: theme.colors.groupped.background,
    },
    previewImage: {
        width: '100%',
        height: '100%',
    },
    previewFallback: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    previewFallbackIcon: {
        color: theme.colors.textSecondary,
    },
    cardCopy: {
        paddingHorizontal: 10,
        paddingTop: 9,
        minHeight: 132,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.text,
    },
    cardMeta: {
        ...Typography.default('semiBold'),
        fontSize: 10,
        lineHeight: 14,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    cardHint: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        marginTop: 3,
    },
    cardStatusLine: {
        ...Typography.default('semiBold'),
        fontSize: 10,
        lineHeight: 14,
        color: theme.colors.text,
        marginTop: 5,
    },
    progressTrack: {
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfacePressed,
        marginTop: 6,
    },
    progressFill: {
        height: '100%',
        borderRadius: 2,
        backgroundColor: theme.colors.accent,
    },
    promptPreviewButton: {
        alignSelf: 'flex-start',
        minHeight: 24,
        marginTop: 7,
        paddingHorizontal: 8,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: theme.colors.surfacePressed,
    },
    promptPreviewButtonDisabled: {
        opacity: 0.62,
    },
    promptPreviewText: {
        ...Typography.default('semiBold'),
        fontSize: 10,
        color: theme.colors.text,
    },
    cardFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingBottom: 10,
        gap: 8,
    },
    cardAction: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
        flex: 1,
    },
    selectedIcon: {
        color: theme.colors.accent,
    },
    deleteButton: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.46)',
    },
    deleteIcon: {
        color: '#FFFFFF',
    },
    retryButton: {
        position: 'absolute',
        top: 8,
        right: 44,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
    },
    retryIcon: {
        color: theme.colors.accent,
    },
    statusPill: {
        position: 'absolute',
        top: 8,
        left: 8,
        minHeight: 24,
        maxWidth: 112,
        borderRadius: 12,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
    },
    statusPillText: {
        ...Typography.default('semiBold'),
        fontSize: 10,
        color: '#17202A',
        flexShrink: 1,
    },
    promptModalRoot: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    promptModalScrim: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.36)',
    },
    promptModalCard: {
        width: '100%',
        maxHeight: '72%',
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    promptModalHeader: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    promptModalTitleWrap: {
        flex: 1,
    },
    promptModalTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    promptModalSubtitle: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    promptModalBody: {
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    promptModalSectionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
        marginBottom: 6,
    },
    promptModalText: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginBottom: 14,
    },
}));
