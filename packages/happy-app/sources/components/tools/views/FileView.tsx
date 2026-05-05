/**
 * View for 'file' tool calls (image attachments sent by user).
 * Downloads and decrypts the encrypted blob via apiAttachments + sessionBlobKey,
 * then renders the full image inline with the thumbhash as placeholder.
 *
 * Falls back to a compact thumb+filename row when image metadata is missing.
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';

const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string().optional(),
    }).optional(),
});

const COMPACT_THUMB_SIZE = 80;
const BORDER_RADIUS = 8;
const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;

export const FileView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;

    const { name, size, image, ref } = parsed.data;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image?.thumbhash]);

    const { uri, error } = useAttachmentImage(sessionId ?? '', sessionId ? ref : undefined);

    // Inline render with original aspect ratio when we have image dimensions.
    if (image && image.width > 0 && image.height > 0) {
        const aspect = image.width / image.height;
        let displayW = Math.min(image.width, MAX_IMAGE_WIDTH);
        let displayH = displayW / aspect;
        if (displayH > MAX_IMAGE_HEIGHT) {
            displayH = MAX_IMAGE_HEIGHT;
            displayW = displayH * aspect;
        }

        return (
            <View style={styles.inlineContainer}>
                <View style={[styles.inlineWrapper, { borderColor: theme.colors.divider }]}>
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
                </View>
                <Text style={[styles.filename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
            </View>
        );
    }

    // Compact fallback: no image metadata, just a thumbhash placeholder + meta row.
    const sizeLabel = size != null ? formatBytes(size) : null;
    return (
        <View style={styles.compactContainer}>
            <View style={[styles.compactThumb, { borderColor: theme.colors.divider }]}>
                {placeholder ? (
                    <Image
                        source={placeholder}
                        style={[{ width: COMPACT_THUMB_SIZE, height: COMPACT_THUMB_SIZE }, styles.compactThumbImage]}
                        contentFit="cover"
                    />
                ) : (
                    <View style={[styles.compactThumbFallback, { backgroundColor: theme.colors.surfaceHigh, width: COMPACT_THUMB_SIZE, height: COMPACT_THUMB_SIZE }]}>
                        <Ionicons name="image-outline" size={28} color={theme.colors.textSecondary} />
                    </View>
                )}
            </View>
            <View style={styles.meta}>
                <Text style={[styles.filename, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                {sizeLabel && (
                    <Text style={[styles.details, { color: theme.colors.textSecondary }]}>{sizeLabel}</Text>
                )}
            </View>
        </View>
    );
});

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    compactContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 12,
    },
    compactThumb: {
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
    },
    compactThumbImage: {
        borderRadius: BORDER_RADIUS,
    },
    compactThumbFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    meta: {
        flex: 1,
        gap: 2,
    },
    filename: {
        fontSize: 13,
        fontWeight: '500',
    },
    details: {
        fontSize: 12,
    },
}));
