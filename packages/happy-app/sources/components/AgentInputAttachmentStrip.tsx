/**
 * Horizontal scrollable strip showing selected image attachment thumbnails.
 * Each thumbnail shows the image with a remove button.
 * Uses thumbhash as a blurry placeholder while the full image loads.
 */
import * as React from 'react';
import { View, Text, Pressable, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { imageViewer } from '@/sync/imageViewer';
import { HorizontalScrollView } from '@/components/HorizontalScrollView';
import { computeInputAttachmentImageSize } from '@/utils/attachmentGalleryLayout';
import type { AttachmentGalleryPresentation } from '@/utils/attachmentGalleryLayout';
import { MediaAttachmentPlayer } from '@/components/tools/views/MediaAttachmentPlayer';
import { t } from '@/text';

const THUMB_SIZE = 72;
const FEATURED_MAX_WIDTH = 320;
const FEATURED_MAX_HEIGHT = 220;
const BORDER_RADIUS = 12;
const EMPTY_HEADERS: Record<string, string> = {};

interface AgentInputAttachmentStripProps {
    images: AttachmentPreview[];
    onRemove: (id: string) => void;
    presentation?: AttachmentGalleryPresentation;
}

export function AgentInputAttachmentStrip({ images, onRemove, presentation = 'compact' }: AgentInputAttachmentStripProps) {
    const { theme } = useUnistyles();

    if (images.length === 0) return null;

    return (
        // HorizontalScrollView arbitrates against the full-width drawer open
        // gesture so swiping this strip doesn't yank the sidebar out. See
        // HorizontalScrollView.tsx / AttachmentGalleryView for the rationale.
        <HorizontalScrollView
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
            contentContainerStyle={styles.stripContent}
            keyboardShouldPersistTaps="always"
        >
            {images.map((img) => (
                <AttachmentThumbnail
                    key={img.id}
                    image={img}
                    images={images}
                    onRemove={onRemove}
                    presentation={presentation}
                    theme={theme}
                />
            ))}
        </HorizontalScrollView>
    );
}

function AttachmentThumbnail({
    image,
    images,
    onRemove,
    presentation,
    theme,
}: {
    image: AttachmentPreview;
    images: AttachmentPreview[];
    onRemove: (id: string) => void;
    presentation: AttachmentGalleryPresentation;
    theme: any;
}) {
    const windowDimensions = useWindowDimensions();
    const [mediaExpanded, setMediaExpanded] = React.useState(false);
    // Build placeholder from thumbhash if available (hook must run before any
    // early return to keep hook order stable).
    const placeholder = React.useMemo(() => {
        if (!image.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image.thumbhash]);

    if (image.kind === 'video') {
        const videoWidth = Math.max(240, Math.min(480, windowDimensions.width - 64));
        return (
            <View testID="media-attachment-inline-pending" style={[styles.inlineVideoContainer, { width: videoWidth }]}>
                <MediaAttachmentPlayer
                    uri={image.uri}
                    headers={EMPTY_HEADERS}
                    title={image.name}
                    kind="video"
                    mimeType={image.mimeType}
                    testID="media-attachment-player-pending"
                />
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.delete')}
                    onPress={() => onRemove(image.id)}
                    hitSlop={6}
                    style={(p) => [
                        styles.videoRemoveButton,
                        {
                            backgroundColor: theme.colors.surfaceHigh,
                            borderColor: theme.colors.divider,
                            opacity: p.pressed ? 0.7 : 1,
                        },
                    ]}
                >
                    <Ionicons name="close" size={12} color={theme.colors.text} />
                </Pressable>
            </View>
        );
    }

    // Audio keeps its compact identity card because it has no visual frame.
    if (image.kind === 'audio') {
        const cardLabel = mediaExpanded
            ? t('imageUpload.mediaCollapse', { name: image.name })
            : t('imageUpload.mediaPlay', { name: image.name });
        return (
            <View style={[styles.mediaContainer, mediaExpanded && styles.mediaContainerExpanded]}>
                <Pressable
                    testID="media-attachment-card-pending"
                    accessibilityRole="button"
                    accessibilityLabel={cardLabel}
                    accessibilityState={{ expanded: mediaExpanded }}
                    aria-expanded={mediaExpanded}
                    onPress={() => setMediaExpanded((value) => !value)}
                    style={(p) => [
                        styles.mediaCard,
                        { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
                        p.pressed && styles.mediaCardPressed,
                    ]}
                >
                    <Ionicons
                        name="musical-notes"
                        size={22}
                        color={theme.colors.text}
                    />
                    <View style={styles.mediaMeta}>
                        <Text numberOfLines={1} style={[styles.mediaName, { color: theme.colors.text }]}>
                            {image.name}
                        </Text>
                        <Text numberOfLines={1} style={[styles.mediaType, { color: theme.colors.textSecondary }]}>
                            {t('imageUpload.mediaAudio')}
                        </Text>
                    </View>
                    <Ionicons
                        name={mediaExpanded ? 'chevron-up' : 'play-circle'}
                        size={26}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
                {mediaExpanded ? (
                    <View style={styles.mediaPlayerFrame}>
                        <MediaAttachmentPlayer
                            uri={image.uri}
                            headers={EMPTY_HEADERS}
                            title={image.name}
                            kind="audio"
                            mimeType={image.mimeType}
                            testID="media-attachment-player-pending"
                        />
                    </View>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.delete')}
                    onPress={() => onRemove(image.id)}
                    hitSlop={6}
                    style={(p) => [
                        styles.removeButton,
                        {
                            backgroundColor: theme.colors.surfaceHigh,
                            borderColor: theme.colors.divider,
                            opacity: p.pressed ? 0.7 : 1,
                        },
                    ]}
                >
                    <Ionicons name="close" size={12} color={theme.colors.text} />
                </Pressable>
            </View>
        );
    }

    if (image.kind === 'file') {
        return (
            <View style={styles.mediaContainer}>
                <View
                    testID="document-attachment-card-pending"
                    style={[
                        styles.mediaCard,
                        { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
                    ]}
                >
                    <Ionicons name="document-text-outline" size={22} color={theme.colors.text} />
                    <View style={styles.mediaMeta}>
                        <Text numberOfLines={1} style={[styles.mediaName, { color: theme.colors.text }]}>
                            {image.name}
                        </Text>
                        <Text numberOfLines={1} style={[styles.mediaType, { color: theme.colors.textSecondary }]}>
                            {t('imageUpload.documentPdf')}
                        </Text>
                    </View>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.delete')}
                    onPress={() => onRemove(image.id)}
                    hitSlop={6}
                    style={(p) => [
                        styles.removeButton,
                        {
                            backgroundColor: theme.colors.surfaceHigh,
                            borderColor: theme.colors.divider,
                            opacity: p.pressed ? 0.7 : 1,
                        },
                    ]}
                >
                    <Ionicons name="close" size={12} color={theme.colors.text} />
                </Pressable>
            </View>
        );
    }

    const maxFeaturedWidth = Math.max(THUMB_SIZE, Math.min(FEATURED_MAX_WIDTH, windowDimensions.width - 64));
    const displaySize = computeInputAttachmentImageSize({
        presentation,
        sourceWidth: image.width,
        sourceHeight: image.height,
        maxWidth: maxFeaturedWidth,
        maxHeight: FEATURED_MAX_HEIGHT,
    });
    const isFeatured = presentation === 'featured';
    const viewerImages = images.filter((item) => (item.kind ?? 'image') === 'image');
    const viewerIndex = viewerImages.findIndex((item) => item.id === image.id);

    return (
        <View style={[styles.thumbContainer, displaySize]}>
            {/* Tap the image to open the fullscreen swipeable viewer at this one. */}
            <Pressable
                onPress={() => imageViewer.open(
                    viewerImages.map((it) => ({ uri: it.uri, width: it.width, height: it.height, filename: it.name })),
                    Math.max(0, viewerIndex),
                )}
                style={[styles.thumbPressable, displaySize, { borderColor: theme.colors.divider }]}
            >
                <Image
                    source={{ uri: image.uri }}
                    placeholder={placeholder}
                    style={[displaySize, styles.thumb]}
                    contentFit={isFeatured ? 'contain' : 'cover'}
                    transition={150}
                />
            </Pressable>
            {/* Remove button — sits above the image so its tap doesn't open the viewer. */}
            <Pressable
                onPress={() => onRemove(image.id)}
                hitSlop={6}
                style={(p) => [
                    styles.removeButton,
                    {
                        backgroundColor: theme.colors.surfaceHigh,
                        borderColor: theme.colors.divider,
                        opacity: p.pressed ? 0.7 : 1,
                    },
                ]}
            >
                <Ionicons name="close" size={12} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    strip: {
        marginBottom: 8,
        marginHorizontal: 8,
    },
    stripContent: {
        flexDirection: 'row',
        gap: 8,
        // 删除按钮绝对定位在缩略图框外侧（top/right: -6），ScrollView 会裁切超出内容区的子元素，
        // 故内边距需 ≥6px 把按钮兜进可滚动区域，否则最右/最上缩略图的 ❌ 会被裁掉
        paddingHorizontal: 8,
        paddingTop: 8,
    },
    thumbContainer: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        overflow: 'visible',
        position: 'relative',
    },
    mediaContainer: {
        width: 300,
        position: 'relative',
    },
    mediaContainerExpanded: {
        height: 252,
    },
    inlineVideoContainer: {
        maxWidth: 480,
        position: 'relative',
        overflow: 'visible',
    },
    mediaCard: {
        width: 300,
        height: THUMB_SIZE,
        borderWidth: 1,
        borderRadius: BORDER_RADIUS,
        paddingHorizontal: 10,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
    },
    mediaCardPressed: {
        opacity: 0.78,
    },
    mediaMeta: {
        flex: 1,
    },
    mediaName: {
        fontSize: 12,
        lineHeight: 15,
    },
    mediaType: {
        fontSize: 11,
        marginTop: 2,
    },
    mediaPlayerFrame: {
        width: 300,
        height: 180,
        overflow: 'hidden',
        borderBottomLeftRadius: BORDER_RADIUS,
        borderBottomRightRadius: BORDER_RADIUS,
        backgroundColor: '#000',
    },
    thumbPressable: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
    },
    thumb: {
        borderRadius: BORDER_RADIUS,
    },
    removeButton: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    videoRemoveButton: {
        position: 'absolute',
        top: -6,
        left: -6,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
}));
