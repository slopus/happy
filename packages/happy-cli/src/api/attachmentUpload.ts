import axios from 'axios';
import { createReadStream } from 'node:fs';

export interface UploadDescriptor {
    ref: string;
    uploadUrl: string;
    method: 'PUT' | 'POST';
    formFields?: Record<string, string>;
}

/**
 * Ask the server for an upload slot. Mirrors the app-side request-upload call.
 * Returns the ref (stable id used in the file event) and where to PUT/POST the
 * encrypted bytes.
 */
export async function requestAttachmentUpload(
    serverUrl: string,
    token: string,
    sessionId: string,
    filename: string,
    size: number,
    kind?: 'audio' | 'video',
): Promise<UploadDescriptor> {
    const url = `${serverUrl}/v1/sessions/${sessionId}/attachments/request-upload`;
    const res = await axios.post(
        url,
        kind ? { filename, size, kind } : { filename, size },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    return res.data as UploadDescriptor;
}

function isPresignedObjectUrl(url: string): boolean {
    return /[?&](X-Amz-Algorithm|X-Amz-Signature|X-Amz-Credential|Signature|Expires)=/i.test(url);
}

/** Stream a generated audio/video file without loading it into the CLI heap. */
export async function uploadMediaFile(
    descriptor: UploadDescriptor,
    filePath: string,
    size: number,
    mimeType: string,
    token: string,
): Promise<void> {
    if (descriptor.method !== 'PUT') throw new Error(`media upload expected PUT, got ${descriptor.method}`);

    const presigned = isPresignedObjectUrl(descriptor.uploadUrl);
    const headers: Record<string, string | number> = {
        'Content-Length': size,
        'Content-Type': presigned ? mimeType : 'application/octet-stream',
    };
    if (!presigned) headers.Authorization = `Bearer ${token}`;

    const response = await axios.put(descriptor.uploadUrl, createReadStream(filePath), {
        headers,
        timeout: 15 * 60 * 1000,
        maxContentLength: 500 * 1024 * 1024,
        maxBodyLength: 500 * 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`media attachment PUT failed: ${response.status}`);
    }
}

/**
 * Upload the already-encrypted blob. Local-storage mode is a plain PUT to our
 * own server (Bearer required); S3 mode is a presigned POST with formFields and
 * does NOT take an auth header.
 */
export async function uploadEncryptedBlob(
    descriptor: UploadDescriptor,
    encrypted: Uint8Array,
    token: string,
): Promise<void> {
    if (descriptor.method === 'PUT') {
        const res = await axios.put(descriptor.uploadUrl, encrypted, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
            timeout: 60000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength: 50 * 1024 * 1024,
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`attachment PUT failed: ${res.status}`);
        }
        return;
    }
    // POST (S3 presigned): multipart form with formFields + file.
    const form = new FormData();
    // S3 presigned POST requires all policy fields (esp. `key`) to precede the `file` field and ignores anything after it, so this order (formFields first, then file) is load-bearing and must not be reordered.
    for (const [k, v] of Object.entries(descriptor.formFields ?? {})) {
        form.append(k, v);
    }
    form.append('file', new Blob([encrypted], { type: 'application/octet-stream' }), 'blob');
    const abort = AbortSignal.timeout(60000);
    let res: Response;
    try {
        res = await fetch(descriptor.uploadUrl, {
            method: 'POST',
            body: form,
            signal: abort,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`attachment POST network error: ${message}`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`attachment POST failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
}
