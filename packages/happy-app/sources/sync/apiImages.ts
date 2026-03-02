import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

export interface ImageUploadResult {
    url: string;
    mediaType: string;
    width: number;
    height: number;
}

/**
 * Upload an image for a chat session
 * Sends raw image binary with appropriate Content-Type header
 */
export async function uploadSessionImage(
    credentials: AuthCredentials,
    sessionId: string,
    imageData: ArrayBuffer,
    mimeType: string
): Promise<ImageUploadResult> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/images`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': mimeType,
        },
        body: imageData,
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error((error as any).error || `Upload failed: ${response.status}`);
    }

    return await response.json() as ImageUploadResult;
}
