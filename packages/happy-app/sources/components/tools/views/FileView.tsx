/**
 * View for image and media `file` events.
 * Images keep the eager encrypted thumbnail flow. Video resolves directly,
 * while audio resolves only after a click; neither uses a protocol-level card.
 *
 * Image previews use the same square frame as chat attachment galleries,
 * regardless of source dimensions. The viewer preserves the original aspect.
 */
import * as React from 'react';
import { ActivityIndicator, Platform, View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { openSessionImageViewer } from '@/sync/openSessionImageViewer';
import type { ImageViewerSource } from '@/sync/imageViewer';
import { CHAT_IMAGE_THUMB_SIZE } from '@/utils/attachmentGalleryLayout';
import { resolveMediaAttachmentSource } from '@/sync/resolveMediaAttachmentSource';
import { attachmentCacheGeneration, subscribeAttachmentCache } from '@/sync/attachmentCacheContext';
import type { MediaPlaybackSource } from '@/sync/mediaPlaybackSourceTypes';
import { MediaAttachmentPlayer } from './MediaAttachmentPlayer';
import { t } from '@/text';
import { openDocumentAttachment } from '@/sync/openDocumentAttachment';
import { MAX_PDF_FILE_SIZE } from '@/sync/attachmentLimits';
import type { MotionPhotoMetadata } from '@/sync/attachmentTypes';
import { downloadOriginalAttachment } from '@/sync/downloadOriginalAttachment';
import { DesktopShortcutTooltip } from '@/components/DesktopShortcutTooltip';

const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    kind: z.enum(['image', 'audio', 'video', 'file']).optional(),
    mimeType: z.string().optional(),
    encrypted: z.boolean().optional(),
    source: z.enum(['user', 'generated', 'browser_step']).optional(),
    motionPhoto: z.object({
        videoOffset: z.number().int().nonnegative(),
        videoLength: z.number().int().positive(),
        mimeType: z.literal('video/mp4'),
    }).optional(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string().optional(),
    }).optional(),
});

const BORDER_RADIUS = 8;

function directAttachmentUri(ref: string, sessionId: string | undefined): string | null {
    return !sessionId && /^https?:\/\//i.test(ref) ? ref : null;
}

function humanSize(bytes: number | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}

export const FileView = React.memo<ToolViewProps & { onOpenImage?: (source: ImageViewerSource) => void }>(({ tool, sessionId, onOpenImage }) => {
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;
    if (parsed.data.kind === 'video') {
        return (
            <InlineVideoFile
                ref_={parsed.data.ref}
                sessionId={sessionId}
                name={parsed.data.name}
                mimeType={parsed.data.mimeType}
                encrypted={parsed.data.encrypted}
                source={parsed.data.source}
            />
        );
    }
    if (parsed.data.kind === 'audio') {
        return (
            <CompactAudioFile
                ref_={parsed.data.ref}
                sessionId={sessionId}
                name={parsed.data.name}
                mimeType={parsed.data.mimeType}
                encrypted={parsed.data.encrypted}
                source={parsed.data.source}
            />
        );
    }
    if (parsed.data.kind === 'file') {
        return (
            <DocumentFileCard
                ref_={parsed.data.ref}
                sessionId={sessionId}
                name={parsed.data.name}
                size={parsed.data.size}
                mimeType={parsed.data.mimeType}
                encrypted={parsed.data.encrypted}
                source={parsed.data.source}
            />
        );
    }
    return <ImageFileView
        name={parsed.data.name}
        image={parsed.data.image}
        ref_={parsed.data.ref}
        sessionId={sessionId}
        motionPhoto={parsed.data.motionPhoto}
        onOpenImage={onOpenImage}
    />;
});

function DocumentFileCard({ ref_, sessionId, name, size, mimeType, encrypted, source }: {
    ref_: string;
    sessionId?: string;
    name: string;
    size?: number;
    mimeType?: string;
    encrypted?: boolean;
    source?: 'user' | 'generated' | 'browser_step';
}) {
    const { theme } = useUnistyles();
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const resolvedMimeType = mimeType ?? 'application/pdf';
    const sourceType = source === 'generated' ? 'generated' : 'user';
    const sizeLabel = humanSize(size);
    const directUri = directAttachmentUri(ref_, sessionId);
    const canOpen = Boolean(sessionId || directUri);

    const handleOpen = React.useCallback(async () => {
        if (!canOpen || loading) return;
        setLoading(true);
        setError(false);
        let resolved: MediaPlaybackSource | null = null;
        try {
            if (size !== undefined && size > MAX_PDF_FILE_SIZE) {
                throw new Error('File attachment exceeds the safe open limit');
            }
            resolved = directUri
                ? { uri: directUri, headers: {} }
                : await resolveMediaAttachmentSource({
                    sessionId: sessionId!,
                    ref: ref_,
                    mimeType: resolvedMimeType,
                    fileName: name,
                    encrypted,
                });
            await openDocumentAttachment(resolved.uri, name, resolvedMimeType);
        } catch (cause) {
            console.warn(`[document-attachment] failed to open ${name}`, cause);
            setError(true);
        } finally {
            await resolved?.release?.();
            setLoading(false);
        }
    }, [canOpen, directUri, encrypted, loading, name, ref_, resolvedMimeType, sessionId, size]);

    return (
        <View style={styles.inlineContainer}>
            <Pressable
                testID={`document-attachment-card-${sourceType}`}
                accessibilityRole="button"
                accessibilityLabel={t('imageUpload.documentOpen', { name })}
                accessibilityState={{ disabled: !canOpen || loading, busy: loading }}
                disabled={!canOpen || loading}
                onPress={handleOpen}
                style={(press) => [
                    styles.mediaCard,
                    { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
                    press.pressed && styles.mediaCardPressed,
                ]}
            >
                <Ionicons name="document-text-outline" size={22} color={theme.colors.text} />
                <View style={styles.mediaMeta}>
                    <Text style={[styles.filename, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                    <Text style={[styles.mediaSub, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {resolvedMimeType === 'application/pdf' ? t('imageUpload.documentPdf') : t('imageUpload.documentFile')}{sizeLabel ? ` · ${sizeLabel}` : ''}
                    </Text>
                </View>
                {loading
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name="open-outline" size={20} color={theme.colors.textSecondary} />}
            </Pressable>
            {error ? (
                <Text style={[styles.mediaError, { color: theme.colors.textDestructive }]}>
                    {t('imageUpload.documentOpenFailed')}
                </Text>
            ) : null}
        </View>
    );
}

function InlineVideoFile({ ref_, sessionId, name, mimeType, encrypted, source: attachmentSource }: {
    ref_: string;
    sessionId?: string;
    name: string;
    mimeType?: string;
    encrypted?: boolean;
    source?: 'user' | 'generated' | 'browser_step';
}) {
    const { theme } = useUnistyles();
    const generation = React.useSyncExternalStore(subscribeAttachmentCache, attachmentCacheGeneration, attachmentCacheGeneration);
    const [resolved, setResolved] = React.useState<{ source: MediaPlaybackSource; generation: number } | null>(null);
    const source = resolved?.generation === generation ? resolved.source : null;
    const [error, setError] = React.useState(false);
    const sourceType = attachmentSource === 'generated' ? 'generated' : 'user';
    const resolvedMimeType = mimeType ?? 'video/mp4';
    const directUri = directAttachmentUri(ref_, sessionId);

    React.useEffect(() => {
        // Invalidation also destroys active streaming DOM. Resolve with the new
        // ownership context, rather than retaining an old source/refresh closure.
        setResolved(null);
        setError(false);
        if (directUri) {
            setResolved({ source: { uri: directUri, headers: {} }, generation });
            return;
        }
        if (!sessionId) return;
        let cancelled = false;
        void resolveMediaAttachmentSource({
            sessionId,
            ref: ref_,
            mimeType: resolvedMimeType,
            encrypted,
        }).then((resolvedSource) => {
            if (cancelled || attachmentCacheGeneration() !== generation) {
                void resolvedSource.release?.();
                return;
            }
            setResolved({ source: resolvedSource, generation });
        }).catch((cause: unknown) => {
            if (cancelled || attachmentCacheGeneration() !== generation) return;
            console.warn(`[media-attachment] failed to open ${name}`, cause);
            setError(true);
        });
        return () => {
            cancelled = true;
        };
    }, [directUri, encrypted, generation, name, ref_, resolvedMimeType, sessionId]);

    React.useEffect(() => () => {
        void source?.release?.();
    }, [source]);

    return (
        <View testID={`media-attachment-inline-${sourceType}`} style={styles.inlineVideoContainer}>
            {source ? (
                <MediaAttachmentPlayer
                    uri={source.uri}
                    headers={source.headers}
                    reuseKey={source.reuseKey}
                    refreshSource={source.refreshSource}
                    isSourceCurrent={source.isCurrent}
                    title={name}
                    kind="video"
                    mimeType={resolvedMimeType}
                    testID={`media-attachment-player-${sourceType}`}
                />
            ) : (
                <View style={styles.videoLoadingFrame}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            )}
            {error ? (
                <Text style={[styles.mediaError, { color: theme.colors.textDestructive }]}>
                    {t('imageUpload.mediaLoadFailed')}
                </Text>
            ) : null}
        </View>
    );
}

function CompactAudioFile({ ref_, sessionId, name, mimeType, encrypted, source: attachmentSource }: {
    ref_: string;
    sessionId?: string;
    name: string;
    mimeType?: string;
    encrypted?: boolean;
    source?: 'user' | 'generated' | 'browser_step';
}) {
    const { theme } = useUnistyles();
    const [source, setSource] = React.useState<MediaPlaybackSource | null>(null);
    const [state, setState] = React.useState<'idle' | 'loading' | 'error'>('idle');
    const sourceRef = React.useRef<MediaPlaybackSource | null>(null);
    const requestVersion = React.useRef(0);
    const sourceType = attachmentSource === 'generated' ? 'generated' : 'user';
    const resolvedMimeType = mimeType ?? 'audio/mpeg';
    const directUri = directAttachmentUri(ref_, sessionId);
    const playable = Boolean(sessionId || directUri);
    const identity = `${sessionId ?? ''}\u0000${ref_}\u0000${resolvedMimeType}\u0000${encrypted === false ? 'plain' : 'encrypted'}`;
    const identityRef = React.useRef(identity);
    identityRef.current = identity;

    const releaseActiveSource = React.useCallback(() => {
        const activeSource = sourceRef.current;
        sourceRef.current = null;
        if (activeSource) void activeSource.release?.();
    }, []);

    React.useEffect(() => {
        requestVersion.current += 1;
        releaseActiveSource();
        setSource(null);
        setState('idle');
    }, [identity, releaseActiveSource]);

    React.useEffect(() => () => {
        requestVersion.current += 1;
        releaseActiveSource();
    }, [releaseActiveSource]);

    const handlePlay = React.useCallback(async () => {
        if (!playable || state === 'loading' || source) return;
        const version = requestVersion.current + 1;
        requestVersion.current = version;
        setState('loading');
        let resolved: MediaPlaybackSource | null = null;
        try {
            resolved = directUri
                ? { uri: directUri, headers: {} }
                : await resolveMediaAttachmentSource({
                    sessionId: sessionId!,
                    ref: ref_,
                    mimeType: resolvedMimeType,
                    encrypted,
                });
            if (requestVersion.current !== version || identityRef.current !== identity) {
                void resolved.release?.();
                return;
            }
            sourceRef.current = resolved;
            setSource(resolved);
            setState('idle');
        } catch (cause) {
            if (requestVersion.current !== version || identityRef.current !== identity) return;
            console.warn(`[media-attachment] failed to open ${name}`, cause);
            setState('error');
        }
    }, [directUri, encrypted, identity, name, playable, ref_, resolvedMimeType, sessionId, source, state]);

    if (source) {
        return (
            <View testID={`media-attachment-inline-${sourceType}`} style={styles.inlineAudioContainer}>
                <MediaAttachmentPlayer
                    uri={source.uri}
                    headers={source.headers}
                    title={name}
                    kind="audio"
                    mimeType={resolvedMimeType}
                    testID={`media-attachment-player-${sourceType}`}
                    autoPlay
                />
            </View>
        );
    }

    return (
        <View style={styles.inlineAudioContainer}>
            <Pressable
                testID={`media-attachment-play-${sourceType}`}
                accessibilityRole="button"
                accessibilityLabel={t('imageUpload.mediaPlay', { name })}
                accessibilityState={{ disabled: !playable, busy: state === 'loading' }}
                disabled={!playable || state === 'loading'}
                onPress={handlePlay}
                style={(press) => [
                    styles.audioPlayButton,
                    { backgroundColor: press.pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh },
                ]}
            >
                {state === 'loading' ? (
                    <ActivityIndicator size="small" color={theme.colors.text} />
                ) : (
                    <Ionicons
                        name={state === 'error' ? 'refresh-circle' : 'play-circle'}
                        size={28}
                        color={state === 'error' ? theme.colors.textDestructive : theme.colors.text}
                    />
                )}
                <Text style={[styles.audioPlayLabel, { color: theme.colors.text }]}>
                    {t('imageUpload.mediaAudio')}
                </Text>
            </Pressable>
            {state === 'error' ? (
                <Text style={[styles.mediaError, { color: theme.colors.textDestructive }]}>
                    {t('imageUpload.mediaLoadFailed')}
                </Text>
            ) : null}
        </View>
    );
}

function ImageFileView({ name, image, ref_, sessionId, motionPhoto, onOpenImage = openSessionImageViewer }: {
    name: string;
    image?: { width: number; height: number; thumbhash?: string };
    ref_: string;
    sessionId?: string;
    motionPhoto?: MotionPhotoMetadata;
    onOpenImage?: (source: ImageViewerSource) => void;
}) {
    const { theme } = useUnistyles();
    const ref = ref_;
    const [downloadLoading, setDownloadLoading] = React.useState(false);
    const [downloadError, setDownloadError] = React.useState(false);
    const [downloadHovered, setDownloadHovered] = React.useState(false);
    const [downloadFocused, setDownloadFocused] = React.useState(false);
    const downloadTooltipVisible = downloadHovered || downloadFocused;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image?.thumbhash]);

    const directUri = directAttachmentUri(ref, sessionId);
    const attachmentState = useAttachmentImage(sessionId ?? '', sessionId ? ref : undefined);
    const uri = directUri ?? attachmentState.uri;
    const error = attachmentState.error;
    const detectedMotionPhoto = attachmentState.motionPhoto;
    const effectiveMotionPhoto = motionPhoto ?? detectedMotionPhoto;

    const handleOriginalDownload = React.useCallback(async () => {
        if (!effectiveMotionPhoto || !sessionId || downloadLoading) return;
        setDownloadLoading(true);
        setDownloadError(false);
        let resolved: MediaPlaybackSource | null = null;
        try {
            resolved = await resolveMediaAttachmentSource({
                sessionId,
                ref,
                mimeType: 'image/jpeg',
                fileName: name,
            });
            await downloadOriginalAttachment(resolved.uri, name, 'image/jpeg');
        } catch (cause) {
            console.warn(`[motion-photo] failed to download ${name}`, cause);
            setDownloadError(true);
        } finally {
            await resolved?.release?.();
            setDownloadLoading(false);
        }
    }, [downloadLoading, effectiveMotionPhoto, name, ref, sessionId]);

    const displayW = CHAT_IMAGE_THUMB_SIZE;
    const displayH = CHAT_IMAGE_THUMB_SIZE;

    return (
        <View style={styles.inlineContainer}>
            <Pressable
                testID={effectiveMotionPhoto ? 'motion-photo-cover' : undefined}
                accessibilityRole="button"
                accessibilityLabel={name}
                onPress={uri ? () => onOpenImage({
                    uri,
                    width: image?.width,
                    height: image?.height,
                    filename: name,
                    sessionId,
                    attachmentRef: sessionId ? ref : undefined,
                    motionPhoto: effectiveMotionPhoto,
                }) : undefined}
                disabled={!uri}
                style={[styles.inlineWrapper, { width: displayW, height: displayH, borderColor: theme.colors.divider }]}
            >
                <Image
                    source={uri ? { uri } : undefined}
                    placeholder={placeholder}
                    style={[{ width: displayW, height: displayH }, styles.inlineImage]}
                    contentFit="cover"
                    transition={150}
                />
                {error && !uri && (
                    <View style={[styles.errorOverlay, { backgroundColor: theme.colors.surfaceHigh }]}>
                        <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
                    </View>
                )}
            </Pressable>
            {effectiveMotionPhoto ? (
                <View style={[styles.imageMetaRow, { width: displayW }]}>
                    <Text style={[styles.filename, styles.imageFilename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
                    <View style={styles.motionDownloadSlot}>
                    <Pressable
                        testID="motion-photo-download"
                        accessibilityRole="button"
                        accessibilityLabel={t('imageViewer.downloadOriginalMotionPhoto')}
                        accessibilityState={{ disabled: !sessionId || downloadLoading, busy: downloadLoading }}
                        disabled={!sessionId || downloadLoading}
                        onBlur={() => setDownloadFocused(false)}
                        onFocus={() => setDownloadFocused(true)}
                        onHoverIn={() => setDownloadHovered(true)}
                        onHoverOut={() => setDownloadHovered(false)}
                        onPress={handleOriginalDownload}
                        style={(press) => [
                            styles.motionDownloadButton,
                            { backgroundColor: (press.pressed || downloadTooltipVisible) ? theme.colors.surfacePressed : theme.colors.surface },
                        ]}
                    >
                        {downloadLoading
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Ionicons name="download-outline" size={18} color={theme.colors.textSecondary} />}
                    </Pressable>
                        <DesktopShortcutTooltip
                            align="right"
                            compact
                            label={t('imageViewer.downloadOriginalMotionPhoto')}
                            placement="above"
                            testID="motion-photo-download-tooltip"
                            visible={Platform.OS === 'web' && downloadTooltipVisible}
                        />
                    </View>
                </View>
            ) : (
                <Text style={[styles.filename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
            )}
            {downloadError && (
                <Text style={[styles.mediaError, { color: theme.colors.textDestructive }]}>
                    {t('imageViewer.motionPhotoDownloadFailedMessage')}
                </Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    inlineContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 4,
    },
    inlineWrapper: {
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
        alignSelf: 'flex-start',
        position: 'relative',
    },
    inlineImage: {
        borderRadius: BORDER_RADIUS,
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
    filename: {
        fontSize: 13,
        fontWeight: '500',
    },
    imageMetaRow: {
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    imageFilename: {
        flex: 1,
    },
    motionDownloadButton: {
        width: 48,
        height: 48,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    motionDownloadSlot: {
        position: 'relative',
    },
    inlineVideoContainer: {
        width: '100%',
        maxWidth: 960,
        alignSelf: 'stretch',
    },
    inlineAudioContainer: {
        width: 300,
        maxWidth: '100%',
        alignSelf: 'flex-start',
    },
    audioPlayButton: {
        width: 300,
        maxWidth: '100%',
        height: 54,
        borderRadius: 27,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        gap: 8,
    },
    audioPlayLabel: {
        fontSize: 14,
        fontWeight: '600',
    },
    videoLoadingFrame: {
        width: '100%',
        aspectRatio: 16 / 9,
        maxWidth: 960,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
    },
    mediaCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderRadius: BORDER_RADIUS,
        paddingHorizontal: 12,
        paddingVertical: 10,
        alignSelf: 'flex-start',
        width: 300,
        maxWidth: '100%',
    },
    mediaCardPressed: {
        opacity: 0.78,
    },
    mediaMeta: {
        flexShrink: 1,
    },
    mediaSub: {
        fontSize: 11,
        marginTop: 1,
    },
    mediaError: {
        maxWidth: 300,
        fontSize: 11,
    },
}));
