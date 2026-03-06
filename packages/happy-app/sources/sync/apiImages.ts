import { AuthCredentials, refreshTokenFromCLI } from '@/auth/tokenStorage';
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
 * Auto-refreshes token from CLI on 401 and retries once.
 */
export async function uploadSessionImage(
    credentials: AuthCredentials,
    sessionId: string,
    imageData: ArrayBuffer,
    mimeType: string
): Promise<ImageUploadResult> {
    const API_ENDPOINT = getServerUrl();

    let token = credentials.token;
    let response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/images`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': mimeType,
        },
        body: imageData,
    });

    // On 401, try refreshing token from CLI and retry once
    if (response.status === 401) {
        const refreshed = await refreshTokenFromCLI();
        if (refreshed) {
            token = refreshed.token;
            response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/images`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': mimeType,
                },
                body: imageData,
            });
        }
    }

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error((error as any).error || `Upload failed: ${response.status}`);
    }

    return await response.json() as ImageUploadResult;
}
