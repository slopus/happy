import { Platform } from 'react-native';
import { LocalImage } from '@/components/ImagePreview';
import { ImageContent } from './typesRaw';

/**
 * Uploads a chat image to the server and returns the image content for message.
 *
 * Handles different environments:
 * - Web: Fetches URI and converts to Blob
 * - Native: Uses React Native's FormData format with { uri, name, type }
 */
export async function uploadChatImage(
    sessionId: string,
    image: LocalImage,
    token: string,
    apiUrl: string
): Promise<ImageContent> {
    const formData = new FormData();
    const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = `image.${extension}`;

    if (Platform.OS === 'web') {
        // Web: fetch the URI and convert to blob
        const response = await fetch(image.uri);
        const blob = await response.blob();
        formData.append('file', blob, filename);
    } else {
        // Native: use React Native's FormData format
        formData.append('file', {
            uri: image.uri,
            name: filename,
            type: image.mimeType,
        } as any);
    }

    formData.append('sessionId', sessionId);

    const response = await fetch(`${apiUrl}/v1/chat/upload-image`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
        throw new Error(result.error || 'Upload failed');
    }

    return {
        type: 'image',
        url: result.data.url,
        width: result.data.width,
        height: result.data.height,
        mimeType: result.data.mimeType,
        thumbhash: result.data.thumbhash,
    };
}
