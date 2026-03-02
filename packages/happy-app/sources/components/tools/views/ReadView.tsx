import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { StyleSheet } from 'react-native-unistyles';

// Extract image data from tool result
function extractImageData(result: any): { base64: string; mediaType: string } | null {
    if (!result) return null;

    // Case 1: result is array of content blocks (e.g., [{type: 'image', source: {type: 'base64', ...}}])
    if (Array.isArray(result)) {
        for (const block of result) {
            if (block.type === 'image' && block.source?.type === 'base64') {
                return {
                    base64: block.source.data,
                    mediaType: block.source.media_type || 'image/png',
                };
            }
        }
    }

    // Case 2: result itself is an image block
    if (result.type === 'image' && result.source?.type === 'base64') {
        return {
            base64: result.source.data,
            mediaType: result.source.media_type || 'image/png',
        };
    }

    // Case 3: result has base64 field directly
    if (result.base64 && result.mediaType) {
        return {
            base64: result.base64,
            mediaType: result.mediaType,
        };
    }

    return null;
}

function isImageFile(filePath: string): boolean {
    const ext = filePath?.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext || '');
}

export const ReadView = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const { tool } = props;
    const filePath = tool.input?.file_path || '';
    const imageData = extractImageData(tool.result);
    const screenWidth = useWindowDimensions().width;

    // Only render for images with data
    if (!imageData || !isImageFile(filePath)) {
        return null;
    }

    const uri = `data:${imageData.mediaType};base64,${imageData.base64}`;
    const maxWidth = Math.min(screenWidth - 48, 400);

    return (
        <ToolSectionView>
            <View style={styles.imageContainer}>
                <Image
                    source={{ uri }}
                    style={{ width: maxWidth, height: maxWidth, borderRadius: 8 }}
                    contentFit="contain"
                />
            </View>
        </ToolSectionView>
    );
});

// Full view for Read tool (when tapping on tool card)
export const ReadViewFull = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const { tool } = props;
    const filePath = tool.input?.file_path || '';
    const imageData = extractImageData(tool.result);
    const screenWidth = useWindowDimensions().width;

    if (!imageData || !isImageFile(filePath)) {
        return null;
    }

    const uri = `data:${imageData.mediaType};base64,${imageData.base64}`;
    const maxSize = Math.min(screenWidth - 32, 600);

    return (
        <View style={styles.fullContainer}>
            <Image
                source={{ uri }}
                style={{ width: maxSize, height: maxSize, borderRadius: 8 }}
                contentFit="contain"
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    imageContainer: {
        alignItems: 'center',
        paddingVertical: 4,
    },
    fullContainer: {
        alignItems: 'center',
        paddingVertical: 16,
        paddingTop: 32,
    },
}));
