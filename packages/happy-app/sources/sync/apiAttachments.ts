/**
 * Server API for image attachment upload/download.
 *
 * Two storage modes are transparent to the client:
 * - Local: uploadUrl points to the server itself (PUT endpoint)
 * - S3: uploadUrl is a presigned PUT URL
 *
 * The client always follows the same flow:
 *   1. POST request-upload → get { ref, uploadUrl }
 *   2. PUT encrypted blob to uploadUrl
 *   3. Embed ref in the file event sent to the CLI
 */
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type RequestUploadResult = {
    ref: string;
    uploadUrl: string;
};

/**
 * Request a presigned (or server-hosted) upload URL for an attachment.
 * Returns the ref (storage path) and uploadUrl to PUT the encrypted blob.
 */
export async function requestAttachmentUpload(
    credentials: AuthCredentials,
    sessionId: string,
    filename: string,
    size: number,
    mimeType?: string,
): Promise<RequestUploadResult> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-upload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename, size, mimeType }),
    });

    if (!response.ok) {
        if (response.status === 413) {
            throw new Error(`Attachment too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
        }
        if (response.status === 404) {
            throw new Error('Session not found');
        }
        throw new Error(`request-upload failed: ${response.status}`);
    }

    return response.json() as Promise<RequestUploadResult>;
}

/**
 * Upload an encrypted blob to the URL returned by requestAttachmentUpload.
 * For local-storage mode the URL is on the happy-server; for S3 it is a
 * presigned PUT URL (no Authorization header needed or allowed).
 */
export async function uploadEncryptedBlob(
    uploadUrl: string,
    encryptedData: Uint8Array,
    credentials: AuthCredentials,
): Promise<void> {
    const serverUrl = getServerUrl();
    const isServerUrl = uploadUrl.startsWith(serverUrl);

    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
    };
    // Only send auth header for our own server; S3 presigned URLs reject extra headers.
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
    }

    const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: encryptedData.buffer as ArrayBuffer,
    });

    if (!response.ok) {
        throw new Error(`Blob upload failed: ${response.status}`);
    }
}
