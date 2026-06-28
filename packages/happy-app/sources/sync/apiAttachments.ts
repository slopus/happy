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
import {
    createAttachmentDiagnosticError,
    errorMessageFromUnknown,
} from './attachmentDiagnostics';
import { getServerUrl } from './serverConfig';
import { appendFormFile } from './uploadFormFile';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * If a self-hosted server's request-upload / request-download response points
 * at loopback (e.g. PUBLIC_URL not set so it returned http://localhost:3005)
 * the phone can't reach it — that's the server's own loopback. Rewrite the
 * host to whatever the client actually used to talk to the server, since
 * that address is by definition reachable from here. No-op for any non-
 * loopback URL (presigned S3 GET URLs, properly configured PUBLIC_URL, etc.).
 */
function rewriteLoopbackHost(url: string): string {
    try {
        const target = new URL(url);
        if (target.hostname !== 'localhost' && target.hostname !== '127.0.0.1' && target.hostname !== '::1') {
            return url;
        }
        const reachable = new URL(getServerUrl());
        target.protocol = reachable.protocol;
        target.host = reachable.host; // includes port
        return target.toString();
    } catch {
        return url;
    }
}

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
    const requestUrl = `${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-upload`;

    let response: Response;
    try {
        response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ filename, size }),
        });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('request-upload network error', message), {
            leg: 'request-upload',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }

    if (!response.ok) {
        if (response.status === 413) {
            throw createAttachmentDiagnosticError(`Attachment too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`, {
                leg: 'request-upload',
                method: 'POST',
                url: requestUrl,
                serverUrl: API_ENDPOINT,
                response,
            });
        }
        if (response.status === 404) {
            throw createAttachmentDiagnosticError('Session not found', {
                leg: 'request-upload',
                method: 'POST',
                url: requestUrl,
                serverUrl: API_ENDPOINT,
                response,
            });
        }
        throw createAttachmentDiagnosticError(`request-upload failed: ${response.status}`, {
            leg: 'request-upload',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            response,
        });
    }

    let result: RequestUploadResult;
    try {
        result = await response.json() as RequestUploadResult;
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('request-upload response parse error', message), {
            leg: 'request-upload',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    return { ...result, uploadUrl: rewriteLoopbackHost(result.uploadUrl) };
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
    const serverUrl = getServerUrl();

    if (upload.method === 'POST') {
        const formData = new FormData();
        if (upload.formFields) {
            for (const [k, v] of Object.entries(upload.formFields)) {
                formData.append(k, v);
            }
        }
        // S3's content-type rule on presigned POST is satisfied by the
        // policy's Content-Type form field; the per-part type just needs
        // to be something multipart-valid. Filename is cosmetic.
        let cleanup: (() => Promise<void>) | undefined;
        let response: Response;
        try {
            cleanup = await appendFormFile(formData, encryptedData, 'file', 'blob', 'application/octet-stream');
            response = await fetch(upload.uploadUrl, {
                method: 'POST',
                body: formData,
            });
        } catch (err) {
            const message = errorMessageFromUnknown(err);
            await cleanupIgnoringErrors(cleanup);
            throw createAttachmentDiagnosticError(formatNetworkErrorMessage('Blob upload (POST) network error', message), {
                leg: 'blob-upload',
                method: 'POST',
                url: upload.uploadUrl,
                serverUrl,
                message,
            });
        }
        await cleanup?.();
        if (!response.ok) {
            throw createAttachmentDiagnosticError(`Blob upload (POST) failed: ${response.status} ${response.statusText}`, {
                leg: 'blob-upload',
                method: 'POST',
                url: upload.uploadUrl,
                serverUrl,
                response,
            });
        }
        return;
    }

    // PUT (local-storage mode): direct upload to our server.
    const isServerUrl = upload.uploadUrl.startsWith(serverUrl);
    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
    };
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
    }

    // Build a standalone ArrayBuffer of exactly encryptedData.length bytes.
    // RN's iOS Blob polyfill rejects Uint8Array/ArrayBuffer constructors
    // ("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not
    // supported"), so we can't use a Blob body cross-platform — and
    // sending `encryptedData.buffer` raw is unsafe if the Uint8Array is
    // a view onto a larger parent ArrayBuffer (we'd upload the parent's
    // trailing bytes too, padding the ciphertext into something the
    // receiver can't decrypt). new Uint8Array(...) copies into a fresh
    // 32-byte-aligned buffer of exactly the right length, and .buffer
    // is then guaranteed safe to send directly.
    const standalone = new Uint8Array(encryptedData);
    const body = standalone.buffer;

    let response: Response;
    try {
        response = await fetch(upload.uploadUrl, {
            method: 'PUT',
            headers,
            body,
        });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('Blob upload (PUT) network error', message), {
            leg: 'blob-upload',
            method: 'PUT',
            url: upload.uploadUrl,
            serverUrl,
            message,
        });
    }

    if (!response.ok) {
        throw createAttachmentDiagnosticError(`Blob upload (PUT) failed: ${response.status} ${response.statusText}`, {
            leg: 'blob-upload',
            method: 'PUT',
            url: upload.uploadUrl,
            serverUrl,
            response,
        });
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
    const requestUrl = `${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-download`;

    let requestRes: Response;
    try {
        requestRes = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref }),
        });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('request-download network error', message), {
            leg: 'request-download',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    if (!requestRes.ok) {
        throw createAttachmentDiagnosticError(`request-download failed: ${requestRes.status}`, {
            leg: 'request-download',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            response: requestRes,
        });
    }
    let rawDownloadUrl: string;
    try {
        ({ downloadUrl: rawDownloadUrl } = await requestRes.json() as { downloadUrl: string });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('request-download response parse error', message), {
            leg: 'request-download',
            method: 'POST',
            url: requestUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    const downloadUrl = rewriteLoopbackHost(rawDownloadUrl);

    const isServerUrl = downloadUrl.startsWith(API_ENDPOINT);
    const headers: Record<string, string> = {};
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
    }
    let blobRes: Response;
    try {
        blobRes = await fetch(downloadUrl, { headers });
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('Attachment download network error', message), {
            leg: 'blob-download',
            method: 'GET',
            url: downloadUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    if (!blobRes.ok) {
        throw createAttachmentDiagnosticError(`Attachment download failed: ${blobRes.status} ${blobRes.statusText}`, {
            leg: 'blob-download',
            method: 'GET',
            url: downloadUrl,
            serverUrl: API_ENDPOINT,
            response: blobRes,
        });
    }
    let buffer: ArrayBuffer;
    try {
        buffer = await blobRes.arrayBuffer();
    } catch (err) {
        const message = errorMessageFromUnknown(err);
        throw createAttachmentDiagnosticError(formatNetworkErrorMessage('Attachment download body read error', message), {
            leg: 'blob-download',
            method: 'GET',
            url: downloadUrl,
            serverUrl: API_ENDPOINT,
            message,
        });
    }
    return new Uint8Array(buffer);
}

function formatNetworkErrorMessage(prefix: string, message: string): string {
    return message ? `${prefix}: ${message}` : prefix;
}

async function cleanupIgnoringErrors(cleanup: (() => Promise<void>) | undefined): Promise<void> {
    try {
        await cleanup?.();
    } catch {
        // Keep the original upload failure as the reported transfer error.
    }
}
