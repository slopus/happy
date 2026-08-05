import { describe, expect, it } from 'vitest';
import { getMessageModelEffortLabel } from './messageModelEffort';

describe('getMessageModelEffortLabel', () => {
    it('formats the model and effort recorded on that specific user message', () => {
        const historicalMeta = { model: 'gpt-5.6-sol', effort: 'xhigh' };

        expect(getMessageModelEffortLabel(historicalMeta)).toBe('gpt-5.6-sol · xhigh');
        // The formatter has no current-session input, so later composer changes
        // cannot alter this historical label.
        expect(getMessageModelEffortLabel(historicalMeta)).toBe('gpt-5.6-sol · xhigh');
    });

    it('renders explicit reset metadata as default model and effort', () => {
        expect(getMessageModelEffortLabel({ model: null, effort: null })).toBe('default model · default effort');
    });

    it('does not invent values for older messages without mode metadata', () => {
        expect(getMessageModelEffortLabel(undefined)).toBeNull();
        expect(getMessageModelEffortLabel({})).toBeNull();
        expect(getMessageModelEffortLabel({ effort: 'medium' })).toBe('medium');
    });
});
