import type { AuthCredentials } from '@/auth/tokenStorage';
import type { RequestUploadResult } from './apiAttachments';
import { mediaUploadHeaders } from './mediaUploadHeaders';

/** Upload a browser-selected media Blob without copying it into a JS ArrayBuffer. */
export async function uploadMediaFile(
    upload: RequestUploadResult,
    fileUri: string,
    mimeType: string,
    credentials: AuthCredentials,
): Promise<void> {
    if (upload.method !== 'PUT') {
        throw new Error(`Media upload expected PUT, got ${upload.method}`);
    }

    const source = await fetch(fileUri);
    if (!source.ok) {
        throw new Error(`Media source read failed: ${source.status}`);
    }
    const media = await source.blob();
    const headers = mediaUploadHeaders(upload.uploadUrl, mimeType, credentials.token);

    const response = await fetch(upload.uploadUrl, {
        method: 'PUT',
        body: media,
        headers,
    });
    if (!response.ok) {
        throw new Error(`Media upload (PUT) failed: ${response.status} at ${upload.uploadUrl}`);
    }
}
