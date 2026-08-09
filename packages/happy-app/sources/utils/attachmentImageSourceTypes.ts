export type AttachmentImageSourceOptions = {
    maxDimension?: number;
    sourceWidth?: number;
    sourceHeight?: number;
};

export type LoadedAttachmentImageSource = {
    uri: string;
    byteSize: number;
    dispose: () => void;
};

export function getAttachmentPreviewSize(options: AttachmentImageSourceOptions): { width: number; height: number } | null {
    const { maxDimension, sourceWidth, sourceHeight } = options;
    if (!maxDimension || !sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) {
        return null;
    }
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    if (scale >= 1) return null;
    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
    };
}
