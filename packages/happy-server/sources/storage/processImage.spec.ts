import * as fs from 'fs';
import { processImage } from './processImage';
import { describe, it } from 'vitest';

describe('processImage', () => {
    it('should resize image', async () => {
        let img = fs.readFileSync(__dirname + '/__testdata__/image.jpg');
        let result = await processImage(img);
    });
});