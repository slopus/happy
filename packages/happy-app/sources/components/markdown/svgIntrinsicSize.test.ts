import { describe, expect, it } from 'vitest';
import { isDefaultObjectSize, parseSvgIntrinsicSize } from './svgIntrinsicSize';

describe('parseSvgIntrinsicSize', () => {
    it('takes absolute width/height when both are stated', () => {
        expect(parseSvgIntrinsicSize('<svg width="1920" height="760" viewBox="0 0 100 50"></svg>'))
            .toEqual({ width: 1920, height: 760, fromViewBox: false });
    });

    it('accepts a px suffix and surrounding space', () => {
        expect(parseSvgIntrinsicSize('<svg width=" 300px " height="150px"></svg>'))
            .toEqual({ width: 300, height: 150, fromViewBox: false });
    });

    it('falls back to viewBox when the size is a percentage', () => {
        expect(parseSvgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 16 9"></svg>'))
            .toEqual({ width: 16, height: 9, fromViewBox: true });
    });

    it('falls back to viewBox for units that need a font or a DPI', () => {
        expect(parseSvgIntrinsicSize('<svg width="20em" height="10em" viewBox="0 0 40 20"></svg>'))
            .toEqual({ width: 40, height: 20, fromViewBox: true });
    });

    it('reads a comma-separated viewBox with a non-zero origin', () => {
        expect(parseSvgIntrinsicSize('<svg viewBox="10,20,300,100"></svg>'))
            .toEqual({ width: 300, height: 100, fromViewBox: true });
    });

    it('ignores a nested svg: the root element answers for the document', () => {
        const markup = '<svg viewBox="0 0 10 5"><g><svg width="999" height="999"/></g></svg>';
        expect(parseSvgIntrinsicSize(markup)).toEqual({ width: 10, height: 5, fromViewBox: true });
    });

    it('ignores an svg tag that only appears inside a comment', () => {
        const markup = '<!-- <svg width="999" height="1"/> --><svg viewBox="0 0 8 4"></svg>';
        expect(parseSvgIntrinsicSize(markup)).toEqual({ width: 8, height: 4, fromViewBox: true });
    });

    it('handles single-quoted attributes and mixed case', () => {
        expect(parseSvgIntrinsicSize("<SVG WIDTH='40' HEIGHT='20'></SVG>"))
            .toEqual({ width: 40, height: 20, fromViewBox: false });
    });

    it('returns null when neither a size nor a usable viewBox is present', () => {
        expect(parseSvgIntrinsicSize('<svg><rect width="10" height="10"/></svg>')).toBeNull();
        expect(parseSvgIntrinsicSize('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
        expect(parseSvgIntrinsicSize('<svg viewBox="broken"></svg>')).toBeNull();
        expect(parseSvgIntrinsicSize('not markup at all')).toBeNull();
    });

    it('rejects a zero or negative size so nothing divides by it later', () => {
        expect(parseSvgIntrinsicSize('<svg width="0" height="10" viewBox="0 0 6 3"></svg>'))
            .toEqual({ width: 6, height: 3, fromViewBox: true });
        expect(parseSvgIntrinsicSize('<svg width="-5" height="10"></svg>')).toBeNull();
    });
});

describe('isDefaultObjectSize', () => {
    it('recognises what Chrome reports for an SVG with no size of its own', () => {
        expect(isDefaultObjectSize(267, 150)).toBe(true); // viewBox 16:9
        expect(isDefaultObjectSize(300, 75)).toBe(true); // viewBox 4:1
        expect(isDefaultObjectSize(75, 150)).toBe(true); // viewBox 1:2
        expect(isDefaultObjectSize(300, 150)).toBe(true); // viewBox 2:1
        expect(isDefaultObjectSize(266.67, 150.2)).toBe(true);
    });

    it('leaves a size the SVG declared alone', () => {
        expect(isDefaultObjectSize(1920, 760)).toBe(false);
        expect(isDefaultObjectSize(104, 20)).toBe(false); // a badge
        expect(isDefaultObjectSize(400, 200)).toBe(false); // width only, height from the viewBox
        expect(isDefaultObjectSize(300, 300)).toBe(false);
        expect(isDefaultObjectSize(400, 150)).toBe(false);
        expect(isDefaultObjectSize(301, 75)).toBe(false);
    });

    it('also reads an SVG declared exactly at the default box as ratio-only', () => {
        // The browser's answer is the same, so the two cannot be told apart.
        expect(isDefaultObjectSize(300, 100)).toBe(true);
        expect(isDefaultObjectSize(150, 150)).toBe(true);
    });
});
