import { describe, it, expect } from 'vitest';
import { isSvgImageUrl, parseSvgImageSource } from './svgImageSource';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

describe('parseSvgImageSource', () => {
    it('decodes a base64 svg data URI to xml', () => {
        const b64 = Buffer.from(SVG).toString('base64');
        expect(parseSvgImageSource(`data:image/svg+xml;base64,${b64}`)).toEqual({
            kind: 'xml',
            xml: SVG,
        });
    });

    it('decodes a base64 svg data URI with a charset parameter', () => {
        const b64 = Buffer.from(SVG).toString('base64');
        expect(parseSvgImageSource(`data:image/svg+xml;charset=utf-8;base64,${b64}`)).toEqual({
            kind: 'xml',
            xml: SVG,
        });
    });

    it('decodes a percent-encoded utf8 svg data URI to xml', () => {
        expect(parseSvgImageSource(`data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`)).toEqual({
            kind: 'xml',
            xml: SVG,
        });
    });

    it('handles a raw (unencoded) utf8 svg data URI', () => {
        const src = parseSvgImageSource(`data:image/svg+xml,${SVG}`);
        expect(src?.kind).toBe('xml');
        expect((src as { kind: 'xml'; xml: string }).xml).toContain('<svg');
    });

    it('treats a remote .svg URL as a passthrough uri', () => {
        expect(parseSvgImageSource('https://example.com/diagram.svg')).toEqual({
            kind: 'uri',
            uri: 'https://example.com/diagram.svg',
        });
    });

    it('ignores query string / hash when detecting .svg', () => {
        expect(parseSvgImageSource('https://example.com/d.svg?v=2')).toEqual({
            kind: 'uri',
            uri: 'https://example.com/d.svg?v=2',
        });
    });

    it('returns null for raster images so <Image> is used', () => {
        expect(parseSvgImageSource('https://example.com/x.png')).toBeNull();
        expect(parseSvgImageSource('data:image/png;base64,iVBORw0KGgo')).toBeNull();
        expect(parseSvgImageSource('file:///tmp/a.jpg')).toBeNull();
    });

    it('returns null for a malformed svg data URI (no comma)', () => {
        expect(parseSvgImageSource('data:image/svg+xml;base64')).toBeNull();
    });
});

describe('isSvgImageUrl', () => {
    it('agrees with parseSvgImageSource', () => {
        const b64 = Buffer.from(SVG).toString('base64');
        expect(isSvgImageUrl(`data:image/svg+xml;base64,${b64}`)).toBe(true);
        expect(isSvgImageUrl('https://example.com/a.svg')).toBe(true);
        expect(isSvgImageUrl('https://example.com/a.png')).toBe(false);
    });
});
