import { describe, expect, it } from 'vitest';
import { getSettingsFeatureEntries } from './settingsFeatureEntries';

describe('settingsFeatureEntries', () => {
    it('does not expose retired My Agents management entries', () => {
        const entries = getSettingsFeatureEntries({ experiments: false });

        expect(entries.map((entry) => entry.key)).not.toContain('image-style-agent');
        expect(entries.map((entry) => entry.key)).not.toContain('my-agents');
        expect(entries.map((entry) => entry.key)).not.toContain('ask-api');
        expect(entries.map((entry) => entry.key)).not.toContain('public-image-gateway');
    });

    it('does not duplicate the outer usage shortcut inside settings', () => {
        const entries = getSettingsFeatureEntries({ experiments: true });

        expect(entries.map((entry) => entry.key)).not.toContain('usage');
    });
});
