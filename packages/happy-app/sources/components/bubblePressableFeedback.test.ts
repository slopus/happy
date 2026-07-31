import { describe, expect, it } from 'vitest';
import { resolveBubblePressableFeedback } from './bubblePressableFeedback';

describe('resolveBubblePressableFeedback', () => {
    it('disables native scale feedback when opted out', () => {
        expect(resolveBubblePressableFeedback({ platform: 'native', scaleFeedback: false })).toEqual({
            animateScale: false,
        });
    });

    it('keeps native scale feedback enabled by default', () => {
        expect(resolveBubblePressableFeedback({ platform: 'native' })).toEqual({
            animateScale: true,
        });
    });
});
