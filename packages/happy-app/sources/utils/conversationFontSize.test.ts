import { describe, expect, it } from 'vitest';
import { getConversationTypography, getNextConversationFontSize } from './conversationFontSize';

describe('conversation font size', () => {
    it('preserves the existing typography for the default size', () => {
        expect(getConversationTypography('default')).toMatchObject({
            scale: 1,
            body: { fontSize: 16, lineHeight: 25 },
            codeBlock: { fontSize: 14, lineHeight: 20 },
            table: { fontSize: 16, lineHeight: 24 },
        });
    });

    it('provides compact and large typography without changing relative spacing', () => {
        expect(getConversationTypography('small')).toMatchObject({
            body: { fontSize: 14, lineHeight: 22 },
            codeBlock: { fontSize: 12, lineHeight: 18 },
        });
        expect(getConversationTypography('large')).toMatchObject({
            body: { fontSize: 18, lineHeight: 28 },
            codeBlock: { fontSize: 16, lineHeight: 23 },
        });
    });

    it('cycles through all available sizes', () => {
        expect(getNextConversationFontSize('small')).toBe('default');
        expect(getNextConversationFontSize('default')).toBe('large');
        expect(getNextConversationFontSize('large')).toBe('small');
    });
});
