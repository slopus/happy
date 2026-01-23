import { processImage } from './processImage';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

describe('processImage', () => {
    it('resizes pixel data and returns original dimensions', async () => {
        const originalWidth = 200;
        const originalHeight = 100;
        const targetWidth = 100;
        const targetHeight = 50;

        const img = await sharp({
            create: {
                width: originalWidth,
                height: originalHeight,
                channels: 3,
                background: { r: 255, g: 0, b: 0 },
            },
        })
            .jpeg()
            .toBuffer();

        const result = await processImage(img);
        expect(result.format).toBe('jpeg');
        expect(result.width).toBe(originalWidth);
        expect(result.height).toBe(originalHeight);
        expect(result.pixels.length).toBe(targetWidth * targetHeight * 4);
        expect(result.thumbhash.length).toBeGreaterThan(0);
    });
});
