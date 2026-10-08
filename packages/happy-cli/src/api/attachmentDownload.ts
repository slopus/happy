/** Shared native attachment download path, used by session runners and owner history. */
import axios from 'axios';

type AttachmentDownloadInput = {
    serverUrl: string;
    sessionId: string;
    token: string;
    ref: string;
    timeoutMs: number;
    /** Owner history must never send its token to an unrelated download origin. */
    restrictOrigin?: boolean;
};

function responsePreview(data: unknown): string | undefined {
    if (!data) return undefined;
    const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
                : typeof data === 'string'
                    ? data
                    : JSON.stringify(data);
    return text.slice(0, 500);
}

function enrichAttachmentDownloadError(error: unknown, phase: string, url: string): Error {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        const preview = responsePreview(error.response?.data);
        const details = [
            `attachment ${phase} failed`,
            status ? `status=${status}` : undefined,
            statusText ? `statusText=${statusText}` : undefined,
            `url=${url}`,
            preview ? `body=${preview}` : undefined,
        ].filter(Boolean).join(' ');
        const enriched = new Error(details);
        enriched.cause = error;
        return enriched;
    }
    return error instanceof Error ? error : new Error(String(error));
}

export async function openAttachmentDownload(input: AttachmentDownloadInput): Promise<Response> {
    const requestUrl = `${input.serverUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/attachments/request-download`;
    let requestRes;
    try {
        requestRes = await axios.post(
            requestUrl,
            { ref: input.ref },
            {
                headers: { 'Authorization': `Bearer ${input.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
                ...(input.restrictOrigin ? { maxRedirects: 0, maxContentLength: 16 * 1024 } : {}),
            },
        );
    } catch (error) {
        throw enrichAttachmentDownloadError(error, 'request-download', requestUrl);
    }
    const downloadUrl = requestRes.data?.downloadUrl;
    if (typeof downloadUrl !== 'string') {
        throw new Error('request-download returned no downloadUrl');
    }

    const isPresignedS3 = /[?&](X-Amz-Algorithm|X-Amz-Signature|X-Amz-Credential|Signature|Expires)=/.test(downloadUrl);
    const headers: Record<string, string> = {};
    if (!isPresignedS3) {
        headers['Authorization'] = `Bearer ${input.token}`;
    }
    if (input.restrictOrigin) {
        const target = new URL(downloadUrl);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
            || (target.origin !== new URL(input.serverUrl).origin && !isPresignedS3)) {
            throw new Error('Unsupported attachment download origin');
        }
    }
    const abort = AbortSignal.timeout(input.timeoutMs);
    let response: Response;
    try {
        response = await fetch(downloadUrl, {
            headers,
            signal: abort,
            ...(input.restrictOrigin ? { redirect: 'manual' as const } : {}),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`attachment download network error: ${message}`);
    }
    if (!response.ok) {
        if (input.restrictOrigin) {
            await response.body?.cancel();
            throw new Error(`attachment download failed: ${response.status}`);
        }
        const body = await response.text().catch(() => '');
        throw new Error(`attachment download failed: ${response.status}${body ? ` ${body}` : ''}`);
    }
    return response;
}

/** Read encrypted image bytes with a hard bound even when Content-Length is absent. */
export async function downloadAttachment(input: AttachmentDownloadInput & { maxBytes?: number }): Promise<Uint8Array> {
    const response = await openAttachmentDownload(input);
    if (input.maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > input.maxBytes) {
        await response.body?.cancel();
        throw new Error('Attachment size exceeds limit');
    }
    if (!response.body) throw new Error('Attachment body unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > input.maxBytes) {
                await reader.cancel();
                throw new Error('Attachment size exceeds limit');
            }
            chunks.push(chunk.value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}
