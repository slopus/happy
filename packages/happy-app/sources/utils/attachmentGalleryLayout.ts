export type AttachmentGalleryPresentation = 'compact' | 'featured' | 'generated-grid';

const COMPACT_THUMB_SIZE = 100;
const COMPACT_INPUT_THUMB_SIZE = 72;
const DEFAULT_FEATURED_ASPECT = 4 / 3;
const GENERATED_GRID_GAP = 8;
const GENERATED_GRID_HORIZONTAL_PADDING = 12;
const GENERATED_GRID_MIN_ITEM_SIZE = 112;
const GENERATED_GRID_MAX_ITEM_SIZE = 168;
const GENERATED_GRID_MAX_COLUMNS = 6;

export function computeGeneratedAttachmentGridLayout(args: {
    containerWidth: number;
}): {
    columns: number;
    itemSize: number;
    contentWidth: number;
    gap: number;
    horizontalPadding: number;
} {
    const innerWidth = Math.max(0, Math.floor(args.containerWidth) - GENERATED_GRID_HORIZONTAL_PADDING * 2);
    const fittingColumns = Math.floor((innerWidth + GENERATED_GRID_GAP) / (GENERATED_GRID_MIN_ITEM_SIZE + GENERATED_GRID_GAP));
    const columns = Math.max(1, Math.min(GENERATED_GRID_MAX_COLUMNS, fittingColumns));
    const uncappedItemSize = Math.floor((innerWidth - GENERATED_GRID_GAP * (columns - 1)) / columns);
    const itemSize = Math.max(1, Math.min(GENERATED_GRID_MAX_ITEM_SIZE, uncappedItemSize));
    const contentWidth = itemSize * columns + GENERATED_GRID_GAP * (columns - 1);

    return {
        columns,
        itemSize,
        contentWidth,
        gap: GENERATED_GRID_GAP,
        horizontalPadding: GENERATED_GRID_HORIZONTAL_PADDING,
    };
}

export function computeAttachmentGalleryImageSize(args: {
    presentation: AttachmentGalleryPresentation;
    sourceWidth?: number;
    sourceHeight?: number;
    maxWidth: number;
    maxHeight: number;
}): { width: number; height: number } {
    if (args.presentation === 'compact' || args.presentation === 'generated-grid') {
        return { width: COMPACT_THUMB_SIZE, height: COMPACT_THUMB_SIZE };
    }

    const aspect = args.sourceWidth && args.sourceWidth > 0 && args.sourceHeight && args.sourceHeight > 0
        ? args.sourceWidth / args.sourceHeight
        : DEFAULT_FEATURED_ASPECT;
    let width = args.maxWidth;
    let height = width / aspect;
    if (height > args.maxHeight) {
        height = args.maxHeight;
        width = height * aspect;
    }

    return {
        width: Math.round(width),
        height: Math.round(height),
    };
}

export function computeInputAttachmentImageSize(args: {
    presentation: AttachmentGalleryPresentation;
    sourceWidth?: number;
    sourceHeight?: number;
    maxWidth: number;
    maxHeight: number;
}): { width: number; height: number } {
    if (args.presentation === 'compact') {
        return { width: COMPACT_INPUT_THUMB_SIZE, height: COMPACT_INPUT_THUMB_SIZE };
    }

    return computeAttachmentGalleryImageSize(args);
}

export function formatPendingImageElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) {
        return `${totalMinutes}m${seconds.toString().padStart(2, '0')}s`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h${minutes.toString().padStart(2, '0')}m`;
}
