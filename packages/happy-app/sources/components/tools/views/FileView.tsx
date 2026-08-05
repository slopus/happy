/**
 * View for image and media `file` events.
 * Images keep the eager encrypted thumbnail flow. Audio/video starts as an
 * explicit play card and resolves either a plaintext Agent artifact or a
 * decrypted user attachment only when the user expands it.
 *
 * Always renders inline when a ref is present — if dimensions are missing
 * (older messages, iOS picker that didn't report w/h), a default 4:3 aspect
 * ratio is used until the actual image lands and contentFit shows it.
 */
import * as React from 'react';
import { ActivityIndicator, View, Text, Pressable } from 'react-native';
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

const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    kind: z.enum(['image', 'audio', 'video']).optional(),
    mimeType: z.string().optional(),
    encrypted: z.boolean().optional(),
    source: z.enum(['user', 'generated']).optional(),
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

function humanSize(bytes: number | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}

export const FileView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;
    // Audio/video have no visual thumbnail — render a compact card (icon +
    // filename + size) instead of trying to load the blob as an image.
    if (parsed.data.kind === 'audio' || parsed.data.kind === 'video') {
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
    return <ImageFileView name={parsed.data.name} image={parsed.data.image} ref_={parsed.data.ref} sessionId={sessionId} />;
});

function MediaFileCard({ ref_, sessionId, name, kind, size, mimeType, encrypted, source: attachmentSource }: {
    ref_: string;
    sessionId?: string;
    name: string;
    kind: 'audio' | 'video';
    size?: number;
    mimeType?: string;
    encrypted?: boolean;
    source?: 'user' | 'generated';
}) {
    const { theme } = useUnistyles();
    const sizeLabel = humanSize(size);
    const [source, setSource] = React.useState<MediaPlaybackSource | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const sourceType = attachmentSource === 'generated' ? 'generated' : 'user';
    const playerTestID = `media-attachment-player-${sourceType}`;
    const resolvedMimeType = mimeType ?? (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
    const playable = !!sessionId;

    React.useEffect(() => () => {
        void source?.release?.();
    }, [source]);

    const handleToggle = React.useCallback(async () => {
        if (source) {
            setSource(null);
            return;
        }
        if (!sessionId || loading) return;
        setLoading(true);
        setError(false);
        try {
            setSource(await resolveMediaAttachmentSource({
                sessionId,
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
    }, [encrypted, loading, name, ref_, resolvedMimeType, sessionId, source]);

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

function ImageFileView({ name, image, ref_, sessionId }: {
    name: string;
    image?: { width: number; height: number; thumbhash?: string };
    ref_: string;
    sessionId?: string;
}) {
    const { theme } = useUnistyles();
    const ref = ref_;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image?.thumbhash]);

    const { uri, error } = useAttachmentImage(sessionId ?? '', sessionId ? ref : undefined);

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
                onPress={uri ? () => imageViewer.open({ uri, width: image?.width, height: image?.height, filename: name }) : undefined}
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
            <Text style={[styles.filename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
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
