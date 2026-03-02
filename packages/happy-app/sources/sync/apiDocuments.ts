import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

export interface DocumentUploadResult {
    url: string;
    mediaType: string;
    fileName: string;
    fileSize: number;
}

/**
 * Upload a document for a chat session
 * Sends raw binary with appropriate Content-Type header
 */
export async function uploadSessionDocument(
    credentials: AuthCredentials,
    sessionId: string,
    data: ArrayBuffer,
    mimeType: string,
    fileName: string
): Promise<DocumentUploadResult> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(
        `${API_ENDPOINT}/v1/sessions/${sessionId}/documents?fileName=${encodeURIComponent(fileName)}`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': mimeType,
            },
            body: data,
        }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error((error as any).error || `Upload failed: ${response.status}`);
    }

    return await response.json() as DocumentUploadResult;
}
