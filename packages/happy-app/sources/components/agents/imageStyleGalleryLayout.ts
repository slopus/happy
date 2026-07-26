import type { ImageStylePreviewEntry } from './imageStylePreviewManifest';

export const IMAGE_STYLE_GALLERY_COLUMN_COUNT = 2;
export const IMAGE_STYLE_GALLERY_COLUMN_GAP = 10;
export const IMAGE_STYLE_GALLERY_DESKTOP_BREAKPOINT = 900;
export const IMAGE_STYLE_GALLERY_DESKTOP_COLUMN_COUNT = 3;
export const IMAGE_STYLE_GALLERY_DESKTOP_MAX_WIDTH = 1040;
export const IMAGE_STYLE_GALLERY_DESKTOP_MAX_HEIGHT = 760;
export const IMAGE_STYLE_GALLERY_DESKTOP_MARGIN = 32;
export const IMAGE_STYLE_GALLERY_MIN_PREVIEW_HEIGHT = 120;
export const IMAGE_STYLE_GALLERY_MAX_PREVIEW_HEIGHT = 260;
export const IMAGE_STYLE_GALLERY_SHEET_HEIGHT_RATIO = 0.82;
export const IMAGE_STYLE_GALLERY_MIN_SHEET_HEIGHT = 440;
export const IMAGE_STYLE_GALLERY_TOP_MARGIN = 24;
const ESTIMATED_CARD_COPY_HEIGHT = 126;

export type ImageStyleGalleryItemType = 'landscape' | 'portrait' | 'square';

export function getImageStylePreviewHeight(preview: ImageStylePreviewEntry, cardWidth: number) {
    if (preview.width <= 0 || preview.height <= 0 || cardWidth <= 0) {
        return IMAGE_STYLE_GALLERY_MIN_PREVIEW_HEIGHT;
    }

    const proportionalHeight = Math.round((cardWidth * preview.height) / preview.width);
    return Math.min(
        IMAGE_STYLE_GALLERY_MAX_PREVIEW_HEIGHT,
        Math.max(IMAGE_STYLE_GALLERY_MIN_PREVIEW_HEIGHT, proportionalHeight),
    );
}

export function getImageStyleGalleryItemType(preview: ImageStylePreviewEntry): ImageStyleGalleryItemType {
    const ratio = preview.height / preview.width;

    if (ratio >= 1.12) {
        return 'portrait';
    }

    if (ratio <= 0.88) {
        return 'landscape';
    }

    return 'square';
}

export function createImageStyleGalleryColumns<T>(
    items: readonly T[],
    cardWidth: number,
    getPreview: (item: T) => ImageStylePreviewEntry | undefined,
    columnCount = IMAGE_STYLE_GALLERY_COLUMN_COUNT,
) {
    const columns = Array.from({ length: columnCount }, () => [] as T[]);
    const columnHeights = Array.from({ length: columnCount }, () => 0);

    for (const item of items) {
        const targetColumnIndex = columnHeights.indexOf(Math.min(...columnHeights));
        const preview = getPreview(item);
        const previewHeight = preview ? getImageStylePreviewHeight(preview, cardWidth) : IMAGE_STYLE_GALLERY_MIN_PREVIEW_HEIGHT;

        columns[targetColumnIndex].push(item);
        columnHeights[targetColumnIndex] += previewHeight + ESTIMATED_CARD_COPY_HEIGHT;
    }

    return columns;
}

export function getImageStyleGalleryColumnCount(viewportWidth: number) {
    return viewportWidth >= IMAGE_STYLE_GALLERY_DESKTOP_BREAKPOINT
        ? IMAGE_STYLE_GALLERY_DESKTOP_COLUMN_COUNT
        : IMAGE_STYLE_GALLERY_COLUMN_COUNT;
}

export function getImageStyleGalleryDesktopSize(viewportWidth: number, viewportHeight: number) {
    return {
        width: Math.min(
            IMAGE_STYLE_GALLERY_DESKTOP_MAX_WIDTH,
            Math.max(0, viewportWidth - IMAGE_STYLE_GALLERY_DESKTOP_MARGIN * 2),
        ),
        height: Math.min(
            IMAGE_STYLE_GALLERY_DESKTOP_MAX_HEIGHT,
            Math.max(0, viewportHeight - IMAGE_STYLE_GALLERY_DESKTOP_MARGIN * 2),
        ),
    };
}

export function getImageStyleGallerySheetHeight(viewportHeight: number) {
    const availableHeight = Math.max(0, viewportHeight - IMAGE_STYLE_GALLERY_TOP_MARGIN);

    if (availableHeight <= IMAGE_STYLE_GALLERY_MIN_SHEET_HEIGHT) {
        return availableHeight;
    }

    return Math.min(
        Math.round(viewportHeight * IMAGE_STYLE_GALLERY_SHEET_HEIGHT_RATIO),
        availableHeight,
    );
}
