/**
 * Server API for attachment upload/download descriptors and encrypted blobs.
 *
 * Two storage modes are transparent to the client:
 * - Local: uploadUrl points to the server itself (PUT endpoint)
 * - S3: uploadUrl is a presigned PUT URL
 *
 * The client always follows the same flow:
 *   1. POST request-upload → get { ref, uploadUrl }
 *   2. Upload the encrypted image blob or stream plaintext media to uploadUrl
 *   3. Embed ref in the file event sent to the CLI
 */
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { appendFormFile } from './uploadFormFile';
import type { AttachmentKind } from './attachmentTypes';
import { captureAttachmentContext, subscribeAttachmentCache, type AttachmentContext } from './attachmentCacheContext';
import { waitForAttachmentTransfer, withAttachmentDeadline } from './attachmentTransfer';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — encrypted image lane
export const MAX_MEDIA_FILE_SIZE = 500 * 1024 * 1024; // 500MB — plaintext audio/video lane

/**
 * If a self-hosted server's request-upload / request-download response points
 * at loopback (e.g. PUBLIC_URL not set so it returned http://localhost:3005)
 * the phone can't reach it — that's the server's own loopback. Rewrite the
 * host to whatever the client actually used to talk to the server, since
 * that address is by definition reachable from here. No-op for any non-
 * loopback URL (presigned S3 GET URLs, properly configured PUBLIC_URL, etc.).
 */
function rewriteLoopbackHost(url: string, server = getServerUrl()): string {
    try {
        const target = new URL(url);
        if (target.hostname !== 'localhost' && target.hostname !== '127.0.0.1' && target.hostname !== '::1') {
            return url;
        }
        const reachable = new URL(server);
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

export type AttachmentDownloadSource = {
    uri: string;
    headers: Record<string, string>;
};

const downloadSourceInFlight = new Map<string, Promise<AttachmentDownloadSource>>();
const encryptedDownloadInFlight = new Map<string, Promise<Uint8Array>>();
const DOWNLOAD_SOURCE_TTL_MS = 60_000;
const DOWNLOAD_SOURCE_MAX_ENTRIES = 64;
const DOWNLOAD_SOURCE_EXPIRY_MARGIN_MS = 5_000;
const downloadSources = new Map<string, { source: AttachmentDownloadSource; expiresAt: number }>();
subscribeAttachmentCache(() => {
    downloadSources.clear();
    downloadSourceInFlight.clear();
});

/** Keep only short-lived descriptors, never media bytes. Respect S3/OSS signed
 * deadlines as well as the local TTL; malformed deadlines are not reusable. */
function downloadSourceDeadline(uri: string, requestedAt: number): number {
    let expiresAt = requestedAt + DOWNLOAD_SOURCE_TTL_MS;
    try {
        const params = new Map([...new URL(uri).searchParams].map(([name, value]) => [name.toLowerCase(), value]));
        if (params.has('expires')) {
            const seconds = Number(params.get('expires'));
            if (!Number.isFinite(seconds) || seconds <= 0) return 0;
            expiresAt = Math.min(expiresAt, seconds * 1000 - DOWNLOAD_SOURCE_EXPIRY_MARGIN_MS);
        }
        for (const prefix of ['x-amz', 'x-oss']) {
            const date = params.get(`${prefix}-date`);
            const duration = params.get(`${prefix}-expires`);
            if (date === undefined && duration === undefined) continue;
            if (!date || !/^\d{8}T\d{6}Z$/.test(date) || !duration) return 0;
            const start = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
            const seconds = Number(duration);
            if (!Number.isFinite(start) || !Number.isFinite(seconds) || seconds <= 0) return 0;
            expiresAt = Math.min(expiresAt, start + seconds * 1000 - DOWNLOAD_SOURCE_EXPIRY_MARGIN_MS);
        }
    } catch { return 0; }
    return expiresAt;
}

/**
 * Request a presigned (or server-hosted) upload URL for an attachment.
 * Returns the storage ref and the correct upload method for its lane.
 */
export async function requestAttachmentUpload(
    credentials: AuthCredentials,
    sessionId: string,
    filename: string,
    size: number,
    kind: AttachmentKind = 'image',
): Promise<RequestUploadResult> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-upload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        // Only send kind for the media lane; omitting it keeps the request
        // byte-identical to the existing image path.
        body: JSON.stringify(kind === 'image' ? { filename, size } : { filename, size, kind }),
    });

    if (!response.ok) {
        if (response.status === 413) {
            const limit = kind === 'image' ? MAX_FILE_SIZE : MAX_MEDIA_FILE_SIZE;
            throw new Error(`Attachment too large (max ${limit / 1024 / 1024}MB)`);
        }
        if (response.status === 404) {
            throw new Error('Session not found');
        }
        throw new Error(`request-upload failed: ${response.status}`);
    }

    const result = await response.json() as RequestUploadResult;
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
        const cleanup = await appendFormFile(formData, encryptedData, 'file', 'blob', 'application/octet-stream');
        let response: Response;
        try {
            response = await fetch(upload.uploadUrl, {
                method: 'POST',
                body: formData,
            });
        } catch (err) {
            await cleanup();
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Blob upload (POST) network error to ${upload.uploadUrl}: ${message}`);
        }
        await cleanup();
        if (!response.ok) {
            throw new Error(`Blob upload (POST) failed: ${response.status} ${response.statusText} at ${upload.uploadUrl}`);
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
        const message = err instanceof Error ? err.message : String(err);
        // Surface the URL we actually tried to hit — without this, a generic
        // "Network request failed" gives no hint whether the server returned
        // a localhost URL the phone can't resolve, an HTTP URL that ATS
        // blocked, or a real connectivity issue.
        throw new Error(`Blob upload (PUT) network error to ${upload.uploadUrl}: ${message}`);
    }

    if (!response.ok) {
        throw new Error(`Blob upload (PUT) failed: ${response.status} ${response.statusText} at ${upload.uploadUrl}`);
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
    const context = captureAttachmentContext(credentials, sessionId);
    const key = JSON.stringify([context.key, ref]);
    const existing = encryptedDownloadInFlight.get(key);
    if (existing) return existing;
    const download = (async () => {
        await context.assertCurrent();
        const cached = await context.history?.readAttachment(sessionId, ref);
        if (cached) { await context.assertCurrent(); return cached; }
        const source = await requestDownloadSourceAt(context, sessionId, ref);
        await context.assertCurrent();
        let blobRes: Response;
        try {
            blobRes = await fetch(source.uri, { headers: source.headers });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Attachment download network error from ${source.uri}: ${message}`);
        }
        if (!blobRes.ok) throw new Error(`Attachment download failed: ${blobRes.status} ${blobRes.statusText} from ${source.uri}`);
        const bytes = new Uint8Array(await blobRes.arrayBuffer());
        await context.assertCurrent();
        if (context.history) await context.history.writeAttachment(sessionId, ref, bytes, context.fence!);
        await context.assertCurrent();
        return bytes;
    })().finally(() => { if (encryptedDownloadInFlight.get(key) === download) encryptedDownloadInFlight.delete(key); });
    encryptedDownloadInFlight.set(key, download);
    return download;
}

/** Resolve an authenticated local URL or a presigned object-storage URL. */
async function requestAttachmentDownloadSourceUncached(
    token: string,
    API_ENDPOINT: string,
    sessionId: string,
    ref: string,
): Promise<AttachmentDownloadSource> {
    const rawDownloadUrl = await withAttachmentDeadline(async signal => {
        const requestRes = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/attachments/request-download`, {
            method: 'POST',
            signal,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref }),
        });
        if (!requestRes.ok) {
            throw new Error(`request-download failed: ${requestRes.status}`);
        }
        const { downloadUrl } = await requestRes.json() as { downloadUrl: string };
        return downloadUrl;
    }, 20_000);
    const downloadUrl = rewriteLoopbackHost(rawDownloadUrl, API_ENDPOINT);

    const isServerUrl = downloadUrl.startsWith(API_ENDPOINT);
    const headers: Record<string, string> = {};
    if (isServerUrl) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return { uri: downloadUrl, headers };
}

export function requestAttachmentDownloadSource(
    credentials: AuthCredentials,
    sessionId: string,
    ref: string,
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
): Promise<AttachmentDownloadSource> {
    return waitForAttachmentTransfer(requestDownloadSourceAt(captureAttachmentContext(credentials, sessionId), sessionId, ref, options.forceRefresh), options.signal);
}

function requestDownloadSourceAt(context: AttachmentContext, sessionId: string, ref: string, forceRefresh = false) {
    const key = JSON.stringify([context.server, context.key, ref]);
    if (forceRefresh) downloadSources.delete(key);
    const cached = downloadSources.get(key);
    if (cached) {
        downloadSources.delete(key);
        if (cached.expiresAt > Date.now()) {
            downloadSources.set(key, cached); // refresh the bounded LRU order
            return context.assertCurrent().then(() => cached.source);
        }
    }
    const existing = downloadSourceInFlight.get(key);
    if (existing) return existing.then(async source => {
        await context.assertCurrent();
        return source;
    });

    const requestedAt = Date.now();
    const request = requestAttachmentDownloadSourceUncached(context.token, context.server, sessionId, ref)
        .then(async source => {
            // A late response must neither escape nor repopulate the cache after
            // session deletion, account/server change, or credential rotation.
            await context.assertCurrent();
            const expiresAt = downloadSourceDeadline(source.uri, requestedAt);
            const now = Date.now();
            for (const [entryKey, entry] of downloadSources) {
                if (entry.expiresAt <= now) downloadSources.delete(entryKey);
            }
            if (expiresAt > now) {
                downloadSources.set(key, { source, expiresAt });
                while (downloadSources.size > DOWNLOAD_SOURCE_MAX_ENTRIES) {
                    downloadSources.delete(downloadSources.keys().next().value!);
                }
            }
            return source;
        })
        .finally(() => {
            if (downloadSourceInFlight.get(key) === request) downloadSourceInFlight.delete(key);
        });
    downloadSourceInFlight.set(key, request);
    return request;
}
