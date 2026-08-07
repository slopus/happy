function safeDownloadName(fileName: string): string {
    const baseName = fileName.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
    return baseName && baseName !== '.' && baseName !== '..' ? baseName : 'attachment.pdf';
}

/** Share a decrypted PDF through Web Share, falling back to a named download. */
export async function openDocumentAttachment(uri: string, fileName: string, mimeType: string): Promise<void> {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Document download failed: ${response.status}`);
    const blob = await response.blob();
    const name = safeDownloadName(fileName);

    if (
        typeof File !== 'undefined'
        && typeof navigator !== 'undefined'
        && typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
    ) {
        const file = new File([blob], name, { type: mimeType });
        const shareData = { files: [file], title: name };
        if (navigator.canShare(shareData)) {
            try {
                await navigator.share(shareData);
                return;
            } catch (error) {
                // A delayed decrypt/download can outlive transient user activation.
                // Preserve explicit user cancellation, but fall back for activation
                // and capability failures instead of leaving the card inert.
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
            }
        }
    }

    const downloadUrl = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = name;
        anchor.rel = 'noopener';
        anchor.click();
        anchor.remove();
        // Give the browser a task boundary to claim the object URL before it is revoked.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
        URL.revokeObjectURL(downloadUrl);
    }
}
