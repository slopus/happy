import { getImageDownloadFileName } from '@/utils/imageDownloadCore';

/** Start a named browser download from a staged, decrypted original attachment. */
export async function downloadOriginalAttachment(
    uri: string,
    fileName: string,
    _mimeType: string,
): Promise<boolean> {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`Original attachment download failed: ${response.status}`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const safeFileName = getImageDownloadFileName({ uri, filename: fileName });
    try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = safeFileName;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
    return true;
}
