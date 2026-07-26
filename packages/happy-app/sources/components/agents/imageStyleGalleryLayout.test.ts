import { describe, expect, it } from 'vitest';
import {
    createImageStyleGalleryColumns,
    getImageStyleGalleryColumnCount,
    getImageStyleGalleryDesktopSize,
    getImageStyleGalleryItemType,
    getImageStyleGallerySheetHeight,
    getImageStylePreviewHeight,
} from './imageStyleGalleryLayout';
import { IMAGE_STYLE_PREVIEW_MANIFEST } from './imageStylePreviewManifest';

describe('imageStyleGalleryLayout', () => {
    it('keeps preview tiles proportional so portrait styles are not forced into row-height cards', () => {
        const landscape = IMAGE_STYLE_PREVIEW_MANIFEST['scenes-and-illustrations/concept-scene/1'];
        const portrait = IMAGE_STYLE_PREVIEW_MANIFEST['scenes-and-illustrations/concept-scene/2'];
        const cardWidth = 180;

        expect(getImageStyleGalleryItemType(landscape)).toBe('landscape');
        expect(getImageStyleGalleryItemType(portrait)).toBe('portrait');
        expect(getImageStylePreviewHeight(portrait, cardWidth)).toBeGreaterThan(getImageStylePreviewHeight(landscape, cardWidth));
        expect(getImageStylePreviewHeight(landscape, cardWidth)).toBeGreaterThanOrEqual(120);
        expect(getImageStylePreviewHeight(portrait, cardWidth)).toBeLessThanOrEqual(260);
    });

    it('splits styles into masonry columns without dropping or duplicating entries', () => {
        const styles = [
            { id: 'scenes-and-illustrations/concept-scene/1' },
            { id: 'scenes-and-illustrations/concept-scene/2' },
            { id: 'product-visuals/white-background-product/1' },
            { id: 'avatars-and-profile/style-transfer-selfie/1' },
        ];

        const columns = createImageStyleGalleryColumns(
            styles,
            180,
            (style) => IMAGE_STYLE_PREVIEW_MANIFEST[style.id],
        );

        expect(columns).toHaveLength(2);
        expect(columns.flat().map((style) => style.id).sort()).toEqual(styles.map((style) => style.id).sort());
        expect(columns.every((column) => column.length > 0)).toBe(true);
    });

    it('uses an explicit sheet height so Android modals do not collapse to header content', () => {
        expect(getImageStyleGallerySheetHeight(900)).toBe(738);
        expect(getImageStyleGallerySheetHeight(420)).toBeLessThan(420);
    });

    it('uses a bounded three-column dialog on desktop viewports', () => {
        expect(getImageStyleGalleryColumnCount(899)).toBe(2);
        expect(getImageStyleGalleryColumnCount(900)).toBe(3);
        expect(getImageStyleGalleryDesktopSize(1440, 900)).toEqual({ width: 1040, height: 760 });
        expect(getImageStyleGalleryDesktopSize(1024, 720)).toEqual({ width: 960, height: 656 });
    });
});
