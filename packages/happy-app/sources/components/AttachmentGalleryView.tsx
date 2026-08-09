/**
 * Gallery for consecutive image attachments.
 *
 * The wire/sync format still stores each sent image as its own `file`
 * tool-call message (see sync.ts). useGroupedMessages collapses a run of
 * adjacent attachments into a single `image-group` DisplayItem. Ordinary
 * uploaded reference images render as a compact Kimi-style thumbnail strip;
 * GPT Image Agent outputs render larger, preserving the image aspect ratio.
 * Running GPT Image batches can also reserve pending slots so the user sees
 * one loading placeholder per expected image before the file events arrive.
 *
 * Each thumbnail reuses the same decrypt/cache pipeline as FileView
 * (useAttachmentImage + thumbhash placeholder) and opens the fullscreen
 * zoomable viewer on tap.
 */
import * as React from 'react';
import { View, Pressable, useWindowDimensions, ActivityIndicator, Text } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { z } from 'zod';
import { Message } from '@/sync/typesMessage';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { ATTACHMENT_THUMBNAIL_MAX_DIMENSION } from '@/hooks/attachmentImageTypes';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { imageViewer } from '@/sync/imageViewer';
import { HorizontalScrollView } from '@/components/HorizontalScrollView';
import {
    computeAttachmentGalleryImageSize,
    computeGeneratedAttachmentGridLayout,
    formatPendingImageElapsed,
} from '@/utils/attachmentGalleryLayout';
import type { AttachmentGalleryPresentation } from '@/utils/attachmentGalleryLayout';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { GeneratedImageBatchDownload } from '@/components/GeneratedImageBatchDownload';
import type { ImageBatchDownloadItem } from '@/utils/imageBatchDownload';

const THUMB_SIZE = 100;
const FEATURED_MAX_WIDTH = 360;
const FEATURED_MAX_HEIGHT = 520;
const BORDER_RADIUS = 10;

// Same shape FileView parses out of a `file` tool call's input.
const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    kind: z.enum(['image', 'audio', 'video']).optional(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string().optional(),
    }).optional(),
});

type GalleryImage = {
    id: string;
    ref: string;
    name: string;
    width?: number;
    height?: number;
    thumbhash?: string;
    kind?: 'image' | 'audio' | 'video';
    size?: number;
};

type GalleryImageResolution = {
    uri: string | null;
    settled: boolean;
};

/** Extract renderable descriptors from a run of `file` messages. */
function toGalleryImages(messages: Message[]): GalleryImage[] {
    const result: GalleryImage[] = [];
    for (const msg of messages) {
        if (msg.kind !== 'tool-call' || msg.tool.name !== 'file') continue;
        const parsed = fileInputSchema.safeParse(msg.tool.input);
        if (!parsed.success) continue;
        const { ref, name, image, kind, size } = parsed.data;
        result.push({
            id: msg.id,
            ref,
            name,
            width: image?.width,
            height: image?.height,
            thumbhash: image?.thumbhash,
            kind,
            size,
        });
    }
    return result;
}

function galleryHumanSize(bytes: number | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}

export const AttachmentGalleryView = React.memo<{
    messages: Message[];
    sessionId: string;
    presentation?: AttachmentGalleryPresentation;
    pendingCount?: number;
    pendingStartedAt?: number | null;
}>(({ messages, sessionId, presentation = 'compact', pendingCount = 0, pendingStartedAt = null }) => {
    const images = React.useMemo(() => toGalleryImages(messages), [messages]);
    const placeholderCount = Math.max(0, pendingCount);
    const windowDimensions = useWindowDimensions();
    const [frameWidth, setFrameWidth] = React.useState(0);
    const now = useClock(placeholderCount > 0 && !!pendingStartedAt);
    const pendingElapsedLabel = pendingStartedAt
        ? formatPendingImageElapsed(Math.max(0, now - pendingStartedAt))
        : null;

    // Decrypted URIs resolve lazily inside each thumbnail. Keep the URI map for
    // swipe-gallery ordering, and separately track settlement for batch actions.
    const resolvedRef = React.useRef<Map<string, string>>(new Map());
    const resolutionRef = React.useRef<Map<string, GalleryImageResolution>>(new Map());
    const [, setResolutionRevision] = React.useState(0);
    const handleResolution = React.useCallback((id: string, resolution: GalleryImageResolution) => {
        const previous = resolutionRef.current.get(id);
        if (previous?.uri === resolution.uri && previous.settled === resolution.settled) return;

        resolutionRef.current.set(id, resolution);
        if (resolution.uri) resolvedRef.current.set(id, resolution.uri);
        else resolvedRef.current.delete(id);

        setResolutionRevision((revision) => revision + 1);
    }, []);

    const generatedDownloadState = (() => {
        const items: ImageBatchDownloadItem[] = [];
        let settledCount = 0;
        for (const image of images) {
            const resolution = resolutionRef.current.get(image.id);
            if (resolution?.settled) settledCount += 1;
            if (resolution?.uri) {
                items.push({
                    id: image.id,
                    uri: resolution.uri,
                    filename: image.name,
                });
            }
        }
        return { items, settledCount };
    })();

    const handleOpen = React.useCallback((tappedId: string) => {
        // Build the gallery in display order from whatever has resolved so far.
        const ordered = images
            .map((img) => ({ img, uri: resolvedRef.current.get(img.id) }))
            .filter((x): x is { img: GalleryImage; uri: string } => !!x.uri);
        const index = ordered.findIndex((x) => x.img.id === tappedId);
        if (index < 0) return;
        imageViewer.open(
            ordered.map((x) => ({
                uri: x.uri,
                width: x.img.width,
                height: x.img.height,
                filename: x.img.name,
                sessionId,
                attachmentRef: x.img.ref,
            })),
            index,
        );
    }, [images, sessionId]);

    if (images.length === 0 && placeholderCount === 0) return null;

    return (
        <View
            style={styles.galleryFrame}
            testID={`attachment-gallery-${presentation}`}
            onLayout={presentation === 'generated-grid'
                ? (event) => setFrameWidth(Math.round(event.nativeEvent.layout.width))
                : undefined}
        >
            {presentation === 'generated-grid' ? (
                <GeneratedAttachmentGrid
                    images={images}
                    sessionId={sessionId}
                    pendingCount={placeholderCount}
                    pendingElapsedLabel={pendingElapsedLabel}
                    containerWidth={frameWidth || Math.min(windowDimensions.width, layout.maxWidth)}
                    downloadItems={generatedDownloadState.items}
                    settledCount={generatedDownloadState.settledCount}
                    onResolution={handleResolution}
                    onOpen={handleOpen}
                />
            ) : presentation === 'featured' ? (
                <View style={styles.featuredList}>
                    {images.map((img) => (
                        <GalleryThumbnail
                            key={img.id}
                            image={img}
                            sessionId={sessionId}
                            presentation={presentation}
                            onResolution={handleResolution}
                            onOpen={handleOpen}
                        />
                    ))}
                    {Array.from({ length: placeholderCount }, (_, index) => (
                        <GalleryPlaceholder key={`pending-${index}`} presentation={presentation} elapsedLabel={pendingElapsedLabel} />
                    ))}
                </View>
            ) : (
                // HorizontalScrollView (not a plain ScrollView): on mobile the drawer's
                // open gesture spans the full screen width and activates symmetrically,
                // so it would swallow this strip's horizontal swipes. The arbiter Pan in
                // HorizontalScrollView claims horizontal drags (and yields at the left
                // edge so the drawer can still open). See HorizontalScrollView.tsx.
                <HorizontalScrollView
                    showsHorizontalScrollIndicator={false}
                    style={styles.strip}
                    contentContainerStyle={styles.stripContent}
                >
                    {images.map((img) => (
                        <GalleryThumbnail
                            key={img.id}
                            image={img}
                            sessionId={sessionId}
                            presentation={presentation}
                            onResolution={handleResolution}
                            onOpen={handleOpen}
                        />
                    ))}
                    {Array.from({ length: placeholderCount }, (_, index) => (
                        <GalleryPlaceholder key={`pending-${index}`} presentation={presentation} elapsedLabel={pendingElapsedLabel} />
                    ))}
                </HorizontalScrollView>
            )}
        </View>
    );
});

function GeneratedAttachmentGrid({
    images,
    sessionId,
    pendingCount,
    pendingElapsedLabel,
    containerWidth,
    downloadItems,
    settledCount,
    onResolution,
    onOpen,
}: {
    images: GalleryImage[];
    sessionId: string;
    pendingCount: number;
    pendingElapsedLabel: string | null;
    containerWidth: number;
    downloadItems: ImageBatchDownloadItem[];
    settledCount: number;
    onResolution: (id: string, resolution: GalleryImageResolution) => void;
    onOpen: (id: string) => void;
}) {
    const { theme } = useUnistyles();
    const grid = computeGeneratedAttachmentGridLayout({ containerWidth });
    const remainingSlotsInRow = grid.columns - (images.length % grid.columns);
    const visiblePendingCount = Math.min(pendingCount, remainingSlotsInRow);
    const totalCount = images.length + pendingCount;
    const itemSize = { width: grid.itemSize, height: grid.itemSize };

    return (
        <View>
            <View style={styles.generatedHeader}>
                {pendingCount > 0 ? (
                    <View style={styles.generatedProgress}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        <Text
                            testID="attachment-gallery-progress"
                            style={[styles.generatedProgressText, { color: theme.colors.textSecondary }]}
                        >
                            {t('generatedImageBatchDownload.generating', {
                                completed: images.length,
                                total: totalCount,
                            })}
                        </Text>
                        {pendingElapsedLabel ? (
                            <Text style={[styles.generatedElapsed, { color: theme.colors.textSecondary }]}>
                                {pendingElapsedLabel}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                <GeneratedImageBatchDownload
                    items={downloadItems}
                    displayedCount={images.length}
                    settledCount={settledCount}
                    pendingCount={pendingCount}
                />
            </View>
            <View
                testID="attachment-gallery-grid"
                style={[
                    styles.generatedGrid,
                    {
                        width: grid.contentWidth,
                        gap: grid.gap,
                        marginHorizontal: grid.horizontalPadding,
                    },
                ]}
            >
                {images.map((image) => (
                    <GalleryThumbnail
                        key={image.id}
                        image={image}
                        sessionId={sessionId}
                        presentation="generated-grid"
                        displaySizeOverride={itemSize}
                        onResolution={onResolution}
                        onOpen={onOpen}
                    />
                ))}
                {Array.from({ length: visiblePendingCount }, (_, index) => (
                    <GalleryPlaceholder
                        key={`pending-${index}`}
                        presentation="generated-grid"
                        displaySizeOverride={itemSize}
                        elapsedLabel={null}
                    />
                ))}
            </View>
        </View>
    );
}

function useClock(enabled: boolean): number {
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!enabled) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [enabled]);

    return now;
}

const GalleryThumbnail = React.memo<{
    image: GalleryImage;
    sessionId: string;
    presentation: AttachmentGalleryPresentation;
    displaySizeOverride?: { width: number; height: number };
    onResolution: (id: string, resolution: GalleryImageResolution) => void;
    onOpen: (id: string) => void;
}>(({ image, sessionId, presentation, displaySizeOverride, onResolution, onOpen }) => {
    // Audio/video have no thumbnail — render a compact card (icon + filename +
    // size). Dispatch before any image hooks so hook order stays stable.
    if (image.kind === 'audio' || image.kind === 'video') {
        return <GalleryMediaCard image={image} />;
    }
    return <GalleryImageThumb image={image} sessionId={sessionId} presentation={presentation} displaySizeOverride={displaySizeOverride} onResolution={onResolution} onOpen={onOpen} />;
});

function GalleryMediaCard({ image }: { image: GalleryImage }) {
    const { theme } = useUnistyles();
    const sizeLabel = galleryHumanSize(image.size);
    return (
        <View style={[styles.mediaCard, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
            <Ionicons name={image.kind === 'audio' ? 'musical-notes' : 'videocam'} size={20} color={theme.colors.text} />
            <View style={styles.mediaMeta}>
                <Text style={[styles.mediaName, { color: theme.colors.text }]} numberOfLines={1}>{image.name}</Text>
                <Text style={[styles.mediaSub, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                    {image.kind === 'audio' ? '音频' : '视频'}{sizeLabel ? ` · ${sizeLabel}` : ''}
                </Text>
            </View>
        </View>
    );
}

const GalleryImageThumb = React.memo<{
    image: GalleryImage;
    sessionId: string;
    presentation: AttachmentGalleryPresentation;
    displaySizeOverride?: { width: number; height: number };
    onResolution: (id: string, resolution: GalleryImageResolution) => void;
    onOpen: (id: string) => void;
}>(({ image, sessionId, presentation, displaySizeOverride, onResolution, onOpen }) => {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();

    const placeholder = React.useMemo(() => {
        if (!image.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image.thumbhash]);

    const directUri = !sessionId && image.ref.startsWith('data:image/') ? image.ref : null;
    const attachmentState = useAttachmentImage(
        sessionId,
        sessionId ? image.ref : undefined,
        {
            maxDimension: ATTACHMENT_THUMBNAIL_MAX_DIMENSION,
            sourceWidth: image.width,
            sourceHeight: image.height,
        },
    );
    const uri = directUri ?? attachmentState.uri;
    const settled = directUri !== null || (
        !!sessionId && (!!attachmentState.uri || !!attachmentState.error || !attachmentState.loading)
    );

    // Report both URI and settlement: failures must not deadlock a ready batch.
    React.useEffect(() => {
        onResolution(image.id, { uri, settled });
    }, [image.id, onResolution, settled, uri]);

    const maxFeaturedWidth = Math.max(THUMB_SIZE, Math.min(FEATURED_MAX_WIDTH, windowDimensions.width - 56));
    const displaySize = displaySizeOverride ?? computeAttachmentGalleryImageSize({
        presentation,
        sourceWidth: image.width,
        sourceHeight: image.height,
        maxWidth: maxFeaturedWidth,
        maxHeight: FEATURED_MAX_HEIGHT,
    });
    const isFeatured = presentation === 'featured';

    return (
        <Pressable
            testID="attachment-gallery-image"
            onPress={uri ? () => onOpen(image.id) : undefined}
            disabled={!uri}
            style={[
                isFeatured ? styles.featuredWrapper : styles.thumbWrapper,
                displaySize,
                { borderColor: theme.colors.divider },
            ]}
        >
            <Image
                source={uri ? { uri } : undefined}
                placeholder={placeholder}
                style={[displaySize, styles.thumb]}
                contentFit={isFeatured ? 'contain' : 'cover'}
                cachePolicy="none"
                recyclingKey={image.id}
                transition={150}
            />
            {attachmentState.error && !uri && (
                <View
                    testID="attachment-gallery-error"
                    style={[styles.errorOverlay, { backgroundColor: theme.colors.surfaceHigh }]}
                >
                    <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
                </View>
            )}
        </Pressable>
    );
});

const GalleryPlaceholder = React.memo<{
    presentation: AttachmentGalleryPresentation;
    displaySizeOverride?: { width: number; height: number };
    elapsedLabel: string | null;
}>(({ presentation, displaySizeOverride, elapsedLabel }) => {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();
    const maxFeaturedWidth = Math.max(THUMB_SIZE, Math.min(FEATURED_MAX_WIDTH, windowDimensions.width - 56));
    const displaySize = displaySizeOverride ?? computeAttachmentGalleryImageSize({
        presentation,
        maxWidth: maxFeaturedWidth,
        maxHeight: FEATURED_MAX_HEIGHT,
    });
    const isFeatured = presentation === 'featured';

    return (
        <View
            testID="attachment-gallery-placeholder"
            style={[
                isFeatured ? styles.featuredWrapper : styles.thumbWrapper,
                displaySize,
                styles.placeholder,
                {
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                },
            ]}
        >
            <View style={styles.placeholderCenter}>
                <Ionicons name="image-outline" size={isFeatured ? 28 : 20} color={theme.colors.textSecondary} />
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                {elapsedLabel ? (
                    <Text style={[styles.placeholderElapsed, { color: theme.colors.textSecondary }]}>{elapsedLabel}</Text>
                ) : null}
            </View>
            <View style={[styles.placeholderProgressTrack, { backgroundColor: theme.colors.divider }]}>
                <View style={[styles.placeholderProgressBar, { backgroundColor: theme.colors.textSecondary }]} />
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    galleryFrame: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    strip: {
        marginHorizontal: 8,
        marginVertical: 8,
    },
    stripContent: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 4,
    },
    featuredList: {
        alignItems: 'flex-start',
        gap: 12,
        marginHorizontal: 8,
        marginVertical: 8,
        paddingHorizontal: 4,
    },
    generatedHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        gap: 12,
        marginHorizontal: 12,
        marginTop: 8,
        marginBottom: 6,
    },
    generatedProgress: {
        flex: 1,
        minHeight: 28,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    generatedProgressText: {
        fontSize: 13,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    generatedElapsed: {
        marginLeft: 'auto',
        fontSize: 12,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
    },
    generatedGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        marginVertical: 8,
    },
    thumbWrapper: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    featuredWrapper: {
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
        alignSelf: 'flex-start',
        backgroundColor: 'transparent',
    },
    thumb: {
        borderRadius: BORDER_RADIUS,
    },
    placeholder: {
        justifyContent: 'center',
    },
    placeholderCenter: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    placeholderElapsed: {
        fontSize: 13,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    placeholderProgressTrack: {
        position: 'absolute',
        left: 18,
        right: 18,
        bottom: 18,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        opacity: 0.7,
    },
    placeholderProgressBar: {
        width: '45%',
        height: '100%',
        borderRadius: 2,
    },
    errorOverlay: {
        position: 'absolute',
        top: 4,
        right: 4,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    mediaCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        maxWidth: 240,
    },
    mediaMeta: {
        flexShrink: 1,
    },
    mediaName: {
        fontSize: 13,
        fontWeight: '500',
    },
    mediaSub: {
        fontSize: 11,
        marginTop: 1,
    },
}));
