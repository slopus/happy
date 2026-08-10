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
});
