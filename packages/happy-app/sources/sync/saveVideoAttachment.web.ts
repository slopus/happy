import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import type { VideoSaveOptions, VideoSaveResult } from './saveVideoAttachment.types';
import { AttachmentTransferTimeoutError, transferAbortReason, waitForAttachmentTransfer } from './attachmentTransfer';

/** Download the original video with its media filename and authentication. */
export async function saveVideoAttachment(
    source: MediaPlaybackSource,
    fileName: string,
    mimeType: string,
    options: VideoSaveOptions = {},
): Promise<VideoSaveResult> {
    if (options.signal?.aborted) throw transferAbortReason(options.signal);
    if (source.isCurrent && !source.isCurrent()) throw new Error('Video attachment is no longer available');
    const controller = new AbortController();
    const abort = () => controller.abort(transferAbortReason(options.signal!));
    options.signal?.addEventListener('abort', abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new AttachmentTransferTimeoutError()), options.stallTimeoutMs ?? 45_000);
    };
    options.onPhase?.('downloading');
    armDeadline();
    let blob: Blob;
    try {
        const response = await waitForAttachmentTransfer(fetch(source.uri, { headers: source.headers, signal: controller.signal }), controller.signal);
        if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
        const reader = response.body?.getReader();
        if (reader) {
            const chunks: BlobPart[] = [];
            const expected = Number(response.headers.get('Content-Length'));
            let written = 0;
            try {
                while (true) {
                    const { done, value } = await waitForAttachmentTransfer(reader.read(), controller.signal);
                    if (done) break;
                    chunks.push(new Uint8Array(value).buffer);
                    written += value.byteLength;
                    if (value.byteLength) armDeadline();
                    options.onProgress?.({ bytesWritten: written, ...(expected > 0 ? { totalBytes: expected } : {}) });
                }
            } finally {
                if (controller.signal.aborted) void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            blob = new Blob(chunks, { type: response.headers.get('Content-Type') || mimeType });
        } else {
            blob = await waitForAttachmentTransfer(response.blob(), controller.signal);
            options.onProgress?.({ bytesWritten: blob.size, totalBytes: blob.size });
        }
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
    if (source.isCurrent && !source.isCurrent()) throw new Error('Video attachment is no longer available');
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mimeType }));
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
        URL.revokeObjectURL(url);
    }
    return 'downloaded';
}
