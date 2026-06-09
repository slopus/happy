import { describe, it, expect } from 'vitest';
import {
    applySubdomainPreviewCorsHeaders,
    stripResponseHeaders,
} from '@/app/api/routes/previewRoutes';

const MID = '12345678-1234-1234-1234-123456789abc';

// Phase 3 (specs/preview-nextjs-turbopack-hydration/): the preview relay
// proxies upstream response headers verbatim except for a small drop list.
// This spec pins the drop list so future edits don't accidentally
// reintroduce noisy/broken behavior (e.g. dropping `Link` was added to
// silence "preloaded using link preload but not used" warnings from
// platform-origin preloads we can't rewrite).
describe('stripResponseHeaders', () => {
    it('drops content-length (body may be rewritten to a different size)', () => {
        const out = stripResponseHeaders({ 'content-length': '123', 'content-type': 'text/html' });
        expect(out['content-length']).toBeUndefined();
        expect(out['content-type']).toBe('text/html');
    });

    it('drops content-encoding (body has already been decoded upstream)', () => {
        const out = stripResponseHeaders({ 'content-encoding': 'gzip', 'content-type': 'text/html' });
        expect(out['content-encoding']).toBeUndefined();
    });

    it('drops x-frame-options (would block iframe embedding)', () => {
        const out = stripResponseHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' });
        expect(out['x-frame-options']).toBeUndefined();
    });

    it('drops Link response header when no prefix supplied (backwards compat)', () => {
        const linkValue = '</_next/static/chunks/foo.css>; rel=preload; as="style"';
        const out = stripResponseHeaders({ Link: linkValue, 'content-type': 'text/html' });
        expect(out['Link']).toBeUndefined();
        expect(out['link']).toBeUndefined();
    });

    it('drops Link header when all entries are rel=preload (with prefix)', () => {
        const linkValue =
            '</_next/static/chunks/foo.css>; rel=preload; as="style", ' +
            '</_next/static/y.woff2>; rel=preload; as="font"';
        const out = stripResponseHeaders(
            { Link: linkValue, 'content-type': 'text/html' },
            '/v1/preview/m1/3000',
        );
        expect(out['Link']).toBeUndefined();
    });

    it('keeps + rewrites non-preload Link entries (rel=manifest, canonical) when prefix supplied', () => {
        const linkValue =
            '</_next/static/x.css>; rel=preload; as="style", ' +
            '</manifest.json>; rel=manifest, ' +
            '<https://example.com/canonical>; rel=canonical';
        const out = stripResponseHeaders(
            { Link: linkValue, 'content-type': 'text/html' },
            '/v1/preview/m1/3000',
        );
        expect(out['Link']).toBe(
            '</v1/preview/m1/3000/manifest.json>; rel=manifest, <https://example.com/canonical>; rel=canonical',
        );
    });

    it('handles lowercase `link` header (case-insensitive match) with prefix', () => {
        const out = stripResponseHeaders(
            { link: '</a.css>; rel=preload', 'content-type': 'text/html' },
            '/v1/preview/m1/3000',
        );
        expect(out['link']).toBeUndefined();
    });

    it('rewrites Location header absolute path with prefix (Phase A escape plug)', () => {
        const out = stripResponseHeaders(
            { Location: '/admin', 'content-type': 'text/html' },
            '/v1/preview/m1/3000',
        );
        expect(out['Location']).toBe('/v1/preview/m1/3000/admin');
    });

    it('leaves Location header untouched when no prefix supplied (backwards compat)', () => {
        const out = stripResponseHeaders({ Location: '/admin', 'content-type': 'text/html' });
        expect(out['Location']).toBe('/admin');
    });

    it('leaves cross-origin Location header alone even with prefix', () => {
        const out = stripResponseHeaders(
            { Location: 'https://google.com/login', 'content-type': 'text/html' },
            '/v1/preview/m1/3000',
        );
        expect(out['Location']).toBe('https://google.com/login');
    });

    it('preserves cache-control, etag, content-type, and arbitrary headers', () => {
        const out = stripResponseHeaders({
            'cache-control': 'no-store',
            'etag': 'W/"abc"',
            'content-type': 'application/javascript',
            'x-custom-header': 'value',
        });
        expect(out['cache-control']).toBe('no-store');
        expect(out['etag']).toBe('W/"abc"');
        expect(out['content-type']).toBe('application/javascript');
        expect(out['x-custom-header']).toBe('value');
    });
});

describe('applySubdomainPreviewCorsHeaders', () => {
    it('allows sibling preview subdomains for the same machine', () => {
        const out = applySubdomainPreviewCorsHeaders(
            { 'content-type': 'application/json' },
            `https://${MID}-31010.preview.saycode.ai`,
            `${MID}-41009.preview.saycode.ai`,
            'x-client-version',
        );

        expect(out['Access-Control-Allow-Origin']).toBe(`https://${MID}-31010.preview.saycode.ai`);
        expect(out['Access-Control-Allow-Credentials']).toBe('true');
        expect(out['Access-Control-Allow-Methods']).toContain('GET');
        expect(out['Access-Control-Allow-Methods']).toContain('OPTIONS');
        expect(out['Access-Control-Allow-Headers']).toBe('x-client-version');
        expect(out['Vary']).toBe('Origin');
    });

    it('keeps existing Vary values when adding Origin', () => {
        const out = applySubdomainPreviewCorsHeaders(
            { Vary: 'Accept-Encoding' },
            `https://${MID}-31010.preview.saycode.ai`,
            `${MID}-41009.preview.saycode.ai`,
        );

        expect(out['Vary']).toBe('Accept-Encoding, Origin');
    });

    it('does not allow preview origins from a different machine', () => {
        const other = '87654321-4321-4321-4321-cba987654321';
        const out = applySubdomainPreviewCorsHeaders(
            {},
            `https://${other}-31010.preview.saycode.ai`,
            `${MID}-41009.preview.saycode.ai`,
        );

        expect(out['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('does not allow non-preview origins', () => {
        const out = applySubdomainPreviewCorsHeaders(
            {},
            'https://saycode.ai',
            `${MID}-41009.preview.saycode.ai`,
        );

        expect(out['Access-Control-Allow-Origin']).toBeUndefined();
    });
});
