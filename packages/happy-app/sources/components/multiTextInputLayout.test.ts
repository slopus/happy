import { describe, expect, it } from 'vitest';
import { resolveMultiTextInputLayout } from './multiTextInputLayout';

describe('native multiline text input layout', () => {
    it.each([
        ['one line', 22, 120, 22, 0, 0, undefined, 0, { height: 22, containerHeight: 22, scrollEnabled: false }],
        ['multiline growth', 66, 120, 22, 0, 0, undefined, 0, { height: 66, containerHeight: 66, scrollEnabled: false }],
        ['cap enables scrolling', 180, 120, 22, 0, 0, undefined, 0, { height: 120, containerHeight: 120, scrollEnabled: true }],
        ['shrinking below cap', 44, 120, 22, 0, 0, undefined, 0, { height: 44, containerHeight: 44, scrollEnabled: false }],
        ['vertical padding contributes minimum', 10, 120, 22, 4, 6, undefined, 0, { height: 32, containerHeight: 32, scrollEnabled: false }],
        ['explicit minimum keeps a compact input tall enough', 10, 120, 22, 4, 6, 44, 0, { height: 44, containerHeight: 44, scrollEnabled: false }],
        ['composer chrome grows with multiline input', 66, 120, 22, 0, 0, 44, 66, { height: 66, containerHeight: 132, scrollEnabled: false }],
    ])('%s', (_name, contentHeight, maxHeight, lineHeight, paddingTop, paddingBottom, minimumHeight, containerChromeHeight, expected) => {
        expect(resolveMultiTextInputLayout({
            contentHeight,
            maxHeight,
            lineHeight,
            paddingTop,
            paddingBottom,
            minimumHeight,
            containerChromeHeight,
        })).toEqual(expected);
    });

    it('returns to the minimum height immediately when cleared text has a stale measurement', () => {
        expect(resolveMultiTextInputLayout({
            contentHeight: 120,
            hasText: false,
            maxHeight: 120,
            lineHeight: 24,
            paddingTop: 8,
            paddingBottom: 4,
            minimumHeight: 44,
            containerChromeHeight: 66,
        })).toEqual({
            height: 44,
            containerHeight: 110,
            scrollEnabled: false,
        });
    });
});
