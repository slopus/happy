/**
 * View for 'file' tool calls (image attachments sent by user).
 * Phase 6: shows thumbhash placeholder + filename.
 * Phase 7 will add actual decryption and full image display.
 */
import * as React from 'react';
import { View, Text, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';

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

const THUMB_SIZE = 80;
const BORDER_RADIUS = 8;

export const FileView = React.memo<ToolViewProps>(({ tool }) => {
    const { theme } = useUnistyles();
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;

    const { name, size, image } = parsed.data;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        try {
            if (Platform.OS === 'web') {
                const { thumbHashToDataURL } = require('thumbhash');
                const bytes = Uint8Array.from(atob(image.thumbhash), (c) => c.charCodeAt(0));
                return { uri: thumbHashToDataURL(bytes) };
            }
        } catch {
            // fall through
        }
        return undefined;
    }, [image?.thumbhash]);

    const sizeLabel = size != null ? formatBytes(size) : null;
    const dimsLabel = image ? `${image.width}×${image.height}` : null;

    return (
        <View style={styles.container}>
            {/* Thumbnail (thumbhash placeholder; full image rendered in Phase 7) */}
            <View style={[styles.thumbContainer, { borderColor: theme.colors.divider }]}>
                {placeholder ? (
                    <Image
                        source={placeholder}
                        style={styles.thumb}
                        contentFit="cover"
                    />
                ) : (
                    <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: theme.colors.surfaceHigh }]}>
                        <Ionicons name="image-outline" size={28} color={theme.colors.textSecondary} />
                    </View>
                )}
            </View>

            {/* File metadata */}
            <View style={styles.meta}>
                <Text style={[styles.filename, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                {(sizeLabel || dimsLabel) && (
                    <Text style={[styles.details, { color: theme.colors.textSecondary }]}>
                        {[dimsLabel, sizeLabel].filter(Boolean).join(' · ')}
                    </Text>
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

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 12,
    },
    thumbContainer: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
    },
    thumb: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
    },
    thumbFallback: {
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
