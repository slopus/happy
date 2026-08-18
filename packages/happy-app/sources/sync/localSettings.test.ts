import { describe, expect, it } from 'vitest';
import { localSettingsParse } from './localSettings';

describe('localSettingsParse', () => {
    it('defaults conversation font size for existing installations', () => {
        expect(localSettingsParse({}).conversationFontSize).toBe('default');
    });

    it('preserves a valid device-specific conversation font size', () => {
        expect(localSettingsParse({ conversationFontSize: 'small' }).conversationFontSize).toBe('small');
        expect(localSettingsParse({ conversationFontSize: 'large' }).conversationFontSize).toBe('large');
    });

    it('turns full message selection on for existing installations', () => {
        // The whole settings object is persisted on every write, so an install
        // that predates this setting still has the old markdownCopyV2 key on
        // disk. Reusing that key would have pinned those users to per-paragraph
        // selection forever (#1696).
        expect(localSettingsParse({}).fullMessageSelection).toBe(true);
        expect(localSettingsParse({ markdownCopyV2: false }).fullMessageSelection).toBe(true);
    });

    it('still lets a device opt back into selecting in place', () => {
        expect(localSettingsParse({ fullMessageSelection: false }).fullMessageSelection).toBe(false);
    });
});
