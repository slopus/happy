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
    method: 'PUT' | 'POST';
    /** Required form fields when method is POST (S3 presigned POST policy). */
    formFields?: Record<string, string>;
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
): Promise<RequestUploadResult> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-upload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename, size }),
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
 *
 * Two transport modes are supported, picked by the server:
 * - PUT: local-storage mode (our own server) — raw octet-stream body with
 *   Bearer auth so the server can verify session membership before writing.
 * - POST: S3-presigned POST policy — multipart/form-data with the policy's
 *   formFields plus the file. S3 enforces the content-length-range from the
 *   policy, so the client cannot upload more than the agreed limit.
 */
export async function uploadEncryptedBlob(
    upload: { uploadUrl: string; method: 'PUT' | 'POST'; formFields?: Record<string, string> },
    encryptedData: Uint8Array,
    credentials: AuthCredentials,
): Promise<void> {
    if (upload.method === 'POST') {
        const formData = new FormData();
        if (upload.formFields) {
            for (const [k, v] of Object.entries(upload.formFields)) {
                formData.append(k, v);
            }
        }
        const blob = new Blob([encryptedData.buffer as ArrayBuffer], { type: 'application/octet-stream' });
        formData.append('file', blob);
        const response = await fetch(upload.uploadUrl, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            throw new Error(`Blob upload failed: ${response.status}`);
        }
        return;
    }

    // PUT (local-storage mode): direct upload to our server.
    const serverUrl = getServerUrl();
    const isServerUrl = upload.uploadUrl.startsWith(serverUrl);
    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
    };
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
    }

    const response = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers,
        body: encryptedData.buffer as ArrayBuffer,
    });

    if (!response.ok) {
        throw new Error(`Blob upload failed: ${response.status}`);
    }
}

/**
 * Download an encrypted attachment blob.
 *
 * Two-step protocol mirroring the design spec:
 *   1. POST /request-download with the ref → server returns a downloadUrl
 *      (server-relative URL with auth in local mode; presigned S3 GET
 *      otherwise).
 *   2. GET that URL — local mode requires the Bearer header, S3 presigned
 *      URLs reject extra headers.
 */
export async function downloadEncryptedAttachment(
    credentials: AuthCredentials,
    sessionId: string,
    ref: string,
): Promise<Uint8Array> {
    const API_ENDPOINT = getServerUrl();

    const requestRes = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-download`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref }),
    });
    if (!requestRes.ok) {
        throw new Error(`request-download failed: ${requestRes.status}`);
    }
    const { downloadUrl } = await requestRes.json() as { downloadUrl: string };

    const isServerUrl = downloadUrl.startsWith(API_ENDPOINT);
    const headers: Record<string, string> = {};
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
    }
    const blobRes = await fetch(downloadUrl, { headers });
    if (!blobRes.ok) {
        throw new Error(`Attachment download failed: ${blobRes.status}`);
    }
    const buffer = await blobRes.arrayBuffer();
    return new Uint8Array(buffer);
}
