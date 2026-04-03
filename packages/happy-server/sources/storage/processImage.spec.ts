import { processImage } from './processImage';
import { describe, expect, it } from 'vitest';

describe('processImage', () => {
    it('should resize image', async () => {
        const sharp = (await import('sharp')).default;
        const img = await sharp({
            create: {
                width: 200,
                height: 100,
                channels: 3,
                background: { r: 32, g: 128, b: 224 },
            },
        })
            .png()
            .toBuffer();

        const result = await processImage(img);

        expect(result.width).toBe(200);
        expect(result.height).toBe(100);
        expect(result.format).toBe('png');
        expect(result.thumbhash).toBeTruthy();
        expect(result.pixels).toHaveLength(100 * 50 * 4);
    });
});
