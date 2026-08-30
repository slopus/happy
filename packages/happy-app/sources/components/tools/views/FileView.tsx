/**
 * View for image and media `file` events.
 * Images keep the eager encrypted thumbnail flow. Video resolves directly to
 * a bare inline player, while audio retains its compact identity card.
 *
 * Always renders inline when a ref is present — if dimensions are missing
 * (older messages, iOS picker that didn't report w/h), a default 4:3 aspect
 * ratio is used until the actual image lands and contentFit shows it.
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
import { imageViewer } from '@/sync/imageViewer';
import { resolveMediaAttachmentSource } from '@/sync/resolveMediaAttachmentSource';
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
const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;
const DEFAULT_ASPECT = 4 / 3; // when wire-format omits image{} dimensions

function directAttachmentUri(ref: string, sessionId: string | undefined): string | null {
    return !sessionId && /^https?:\/\//i.test(ref) ? ref : null;
}

function humanSize(bytes: number | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}

export const FileView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
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
            <MediaFileCard
                ref_={parsed.data.ref}
                sessionId={sessionId}
                name={parsed.data.name}
                kind={parsed.data.kind}
                size={parsed.data.size}
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
                throw new Error('PDF attachment exceeds the safe open limit');
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
                        {t('imageUpload.documentPdf')}{sizeLabel ? ` · ${sizeLabel}` : ''}
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
    const [source, setSource] = React.useState<MediaPlaybackSource | null>(null);
    const [error, setError] = React.useState(false);
    const sourceType = attachmentSource === 'generated' ? 'generated' : 'user';
    const resolvedMimeType = mimeType ?? 'video/mp4';
    const directUri = directAttachmentUri(ref_, sessionId);

    React.useEffect(() => {
        if (directUri) {
            setError(false);
            setSource({ uri: directUri, headers: {} });
            return;
        }
        if (!sessionId) return;
        let cancelled = false;
        setError(false);
        void resolveMediaAttachmentSource({
            sessionId,
            ref: ref_,
            mimeType: resolvedMimeType,
            encrypted,
        }).then((resolvedSource) => {
            if (cancelled) {
                void resolvedSource.release?.();
                return;
            }
            setSource(resolvedSource);
        }).catch((cause: unknown) => {
            if (cancelled) return;
            console.warn(`[media-attachment] failed to open ${name}`, cause);
            setError(true);
        });
        return () => {
            cancelled = true;
        };
    }, [directUri, encrypted, name, ref_, resolvedMimeType, sessionId]);

    React.useEffect(() => () => {
        void source?.release?.();
    }, [source]);

    return (
        <View testID={`media-attachment-inline-${sourceType}`} style={styles.inlineVideoContainer}>
            {source ? (
                <MediaAttachmentPlayer
                    uri={source.uri}
                    headers={source.headers}
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

function MediaFileCard({ ref_, sessionId, name, kind, size, mimeType, encrypted, source: attachmentSource }: {
    ref_: string;
    sessionId?: string;
    name: string;
    kind: 'audio' | 'video';
    size?: number;
    mimeType?: string;
    encrypted?: boolean;
    source?: 'user' | 'generated' | 'browser_step';
}) {
    const { theme } = useUnistyles();
    const sizeLabel = humanSize(size);
    const [source, setSource] = React.useState<MediaPlaybackSource | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const sourceType = attachmentSource === 'generated' ? 'generated' : 'user';
    const playerTestID = `media-attachment-player-${sourceType}`;
    const resolvedMimeType = mimeType ?? (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
    const directUri = directAttachmentUri(ref_, sessionId);
    const playable = Boolean(sessionId || directUri);

    React.useEffect(() => () => {
        void source?.release?.();
    }, [source]);

    const handleToggle = React.useCallback(async () => {
        if (source) {
            setSource(null);
            return;
        }
        if (!playable || loading) return;
        setLoading(true);
        setError(false);
        try {
            setSource(directUri
                ? { uri: directUri, headers: {} }
                : await resolveMediaAttachmentSource({
                    sessionId: sessionId!,
                    ref: ref_,
                    mimeType: resolvedMimeType,
                    encrypted,
                }));
        } catch (cause) {
            console.warn(`[media-attachment] failed to open ${name}`, cause);
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [directUri, encrypted, loading, name, playable, ref_, resolvedMimeType, sessionId, source]);

    const label = source
        ? t('imageUpload.mediaCollapse', { name })
        : t('imageUpload.mediaPlay', { name });
    return (
        <View style={styles.inlineContainer}>
            <Pressable
                testID={`media-attachment-card-${sourceType}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ expanded: !!source, disabled: !playable || loading }}
                aria-expanded={!!source}
                onPress={playable ? handleToggle : undefined}
                disabled={!playable || loading}
                style={(press) => [
                    styles.mediaCard,
                    { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
                    press.pressed && styles.mediaCardPressed,
                ]}
            >
                <Ionicons name={kind === 'audio' ? 'musical-notes' : 'videocam'} size={20} color={theme.colors.text} />
                <View style={styles.mediaMeta}>
                    <Text style={[styles.filename, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                    <Text style={[styles.mediaSub, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {kind === 'audio' ? t('imageUpload.mediaAudio') : t('imageUpload.mediaVideo')}{sizeLabel ? ` · ${sizeLabel}` : ''}
                    </Text>
                </View>
                {loading
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name={source ? 'chevron-up' : 'play-circle'} size={26} color={theme.colors.textSecondary} />}
            </Pressable>
            {source ? (
                <View style={styles.playerFrame}>
                    <MediaAttachmentPlayer
                        uri={source.uri}
                        headers={source.headers}
                        title={name}
                        kind={kind}
                        mimeType={resolvedMimeType}
                        testID={playerTestID}
                    />
                </View>
            ) : null}
            {error ? (
                <Text style={[styles.mediaError, { color: theme.colors.textDestructive }]}>
                    {t('imageUpload.mediaLoadFailed')}
                </Text>
            ) : null}
        </View>
    );
}

function ImageFileView({ name, image, ref_, sessionId, motionPhoto }: {
    name: string;
    image?: { width: number; height: number; thumbhash?: string };
    ref_: string;
    sessionId?: string;
    motionPhoto?: MotionPhotoMetadata;
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

    // Pick display dimensions. Real w/h drives the aspect ratio when present,
    // but a missing image{} block (older messages, iOS picker that didn't
    // report dimensions) shouldn't downgrade to a compact filename row —
    // the user attached an image, render it inline. Default to 4:3 at the
    // bubble's max width; expo-image's contentFit="cover" handles the
    // mismatch once the real image arrives.
    const aspect = image && image.width > 0 && image.height > 0
        ? image.width / image.height
        : DEFAULT_ASPECT;
    let displayW = Math.min(image?.width && image.width > 0 ? image.width : MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
    let displayH = displayW / aspect;
    if (displayH > MAX_IMAGE_HEIGHT) {
        displayH = MAX_IMAGE_HEIGHT;
        displayW = displayH * aspect;
    }

    return (
        <View style={styles.inlineContainer}>
            <Pressable
                testID={effectiveMotionPhoto ? 'motion-photo-cover' : undefined}
                accessibilityRole="button"
                accessibilityLabel={name}
                onPress={uri ? () => imageViewer.open({
                    uri,
                    width: image?.width,
                    height: image?.height,
                    filename: name,
                    sessionId,
                    attachmentRef: sessionId ? ref : undefined,
                    motionPhoto: effectiveMotionPhoto,
                }) : undefined}
                disabled={!uri}
                style={[styles.inlineWrapper, { borderColor: theme.colors.divider }]}
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
    playerFrame: {
        width: 300,
        maxWidth: '100%',
        overflow: 'hidden',
        borderRadius: BORDER_RADIUS,
        backgroundColor: '#000',
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
