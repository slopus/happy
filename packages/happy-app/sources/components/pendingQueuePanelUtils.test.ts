import { describe, expect, it } from 'vitest';
import { getPendingPreviewText, truncatePendingPreview } from './pendingQueuePanelUtils';

describe('pendingQueuePanelUtils', () => {
    it('uses fallback label when preview text is empty', () => {
        expect(getPendingPreviewText('', 'fallback')).toBe('fallback');
        expect(getPendingPreviewText('   ', 'fallback')).toBe('fallback');
    });

    it('returns trimmed preview when preview text is present', () => {
        expect(getPendingPreviewText('  hello world  ', 'fallback')).toBe('hello world');
    });

    it('truncates long preview with ellipsis', () => {
        expect(truncatePendingPreview('1234567890', 10)).toBe('1234567890');
        expect(truncatePendingPreview('12345678901', 10)).toBe('1234567890…');
    });
});
