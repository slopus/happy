import { describe, expect, it } from 'vitest';
import { getSessionPreviewToggleAction, isSessionPreviewMessageTruncated } from './sessionPreviewMenu';

describe('sessionPreviewMenu', () => {
    describe('getSessionPreviewToggleAction', () => {
        it('returns null for short messages', () => {
            expect(getSessionPreviewToggleAction({ isLong: false, isExpanded: false })).toBeNull();
            expect(getSessionPreviewToggleAction({ isLong: false, isExpanded: true })).toBeNull();
        });

        it('returns expand for truncated collapsed messages', () => {
            expect(getSessionPreviewToggleAction({ isLong: true, isExpanded: false })).toBe('expand');
        });

        it('returns collapse for expanded long messages', () => {
            expect(getSessionPreviewToggleAction({ isLong: true, isExpanded: true })).toBe('collapse');
        });
    });

    describe('isSessionPreviewMessageTruncated', () => {
        it('returns false when line count fits within the collapsed preview', () => {
            expect(isSessionPreviewMessageTruncated({ lineCount: 6, collapsedLineCount: 6 })).toBe(false);
        });

        it('returns true when line count exceeds the collapsed preview', () => {
            expect(isSessionPreviewMessageTruncated({ lineCount: 7, collapsedLineCount: 6 })).toBe(true);
        });
    });
});
