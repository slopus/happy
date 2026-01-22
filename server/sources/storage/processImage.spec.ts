import { processImage } from './processImage';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

describe('processImage', () => {
    it('should resize image', async () => {
        const img = await sharp({
            create: {
                width: 200,
                height: 100,
                channels: 3,
                background: { r: 255, g: 0, b: 0 },
            },
        })
            .jpeg()
            .toBuffer();

        const result = await processImage(img);
        expect(result.format).toBe('jpeg');
        expect(result.width).toBe(200);
        expect(result.height).toBe(100);
        expect(result.thumbhash.length).toBeGreaterThan(0);
        expect(result.pixels.length).toBeGreaterThan(0);
    });
});
