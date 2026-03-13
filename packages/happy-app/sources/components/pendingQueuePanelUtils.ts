export function getPendingPreviewText(previewText: string, emptyLabel: string): string {
    const text = previewText.trim();
    if (text.length === 0) {
        return emptyLabel;
    }
    return text;
}

export function truncatePendingPreview(previewText: string, maxLength = 140): string {
    if (previewText.length <= maxLength) {
        return previewText;
    }
    return `${previewText.slice(0, maxLength)}…`;
}
