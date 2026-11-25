import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import type { VideoSaveResult } from './saveVideoAttachment.types';

/** Download the original video with its media filename and authentication. */
export async function saveVideoAttachment(
    source: MediaPlaybackSource,
    fileName: string,
    mimeType: string,
): Promise<VideoSaveResult> {
    if (source.isCurrent && !source.isCurrent()) throw new Error('Video attachment is no longer available');
    const response = await fetch(source.uri, { headers: source.headers });
    if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
    const blob = await response.blob();
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
