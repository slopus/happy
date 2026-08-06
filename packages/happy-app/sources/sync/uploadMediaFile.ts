import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import type { RequestUploadResult } from './apiAttachments';

/** Stream a native audio/video file directly to private object storage. */
export async function uploadMediaFile(
    upload: RequestUploadResult,
    fileUri: string,
    mimeType: string,
    credentials: AuthCredentials,
): Promise<void> {
    if (upload.method !== 'PUT') {
        throw new Error(`Media upload expected PUT, got ${upload.method}`);
    }

    const serverUrl = getServerUrl();
    const headers: Record<string, string> = { 'Content-Type': mimeType };
    if (upload.uploadUrl.startsWith(serverUrl)) {
        headers.Authorization = `Bearer ${credentials.token}`;
    }

    let result;
    try {
        result = await uploadAsync(upload.uploadUrl, fileUri, {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Media upload (PUT) network error to ${upload.uploadUrl}: ${message}`);
    }
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`Media upload (PUT) failed: ${result.status} at ${upload.uploadUrl}`);
    }
}
