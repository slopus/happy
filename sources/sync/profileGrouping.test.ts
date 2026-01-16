import { describe, expect, it } from 'vitest';
import { toggleFavoriteProfileId } from './profileGrouping';

describe('toggleFavoriteProfileId', () => {
    it('adds the profile id to the front when missing', () => {
        expect(toggleFavoriteProfileId([], 'anthropic')).toEqual(['anthropic']);
    });

    it('removes the profile id when already present', () => {
        expect(toggleFavoriteProfileId(['anthropic', 'openai'], 'anthropic')).toEqual(['openai']);
    });

    it('supports favoriting the default environment (empty profile id)', () => {
        expect(toggleFavoriteProfileId(['anthropic'], '')).toEqual(['', 'anthropic']);
        expect(toggleFavoriteProfileId(['', 'anthropic'], '')).toEqual(['anthropic']);
    });
});
