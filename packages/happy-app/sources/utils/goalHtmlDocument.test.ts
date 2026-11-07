import { describe, expect, it } from 'vitest';
import { goalHtmlDocument, goalHtmlHostDocument } from './goalHtmlDocument';

describe('Goal HTML isolation', () => {
    it('establishes the original policy before any malformed source markup', () => {
        const source = '<!-- <head> --><script>location.href="https://example.invalid"</script>';
        const html = goalHtmlDocument(source);
        expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf(source));
        expect(html).toContain("connect-src 'none'");
    });
    it('adds a separate host that confines document navigation and cannot be escaped by source HTML', () => {
        const source = '</script><script>parent.location="https://example.invalid"</script>';
        const host = goalHtmlHostDocument(source);
        expect(host).toContain('frame-src blob:');
        expect(host).toContain('img-src data: blob:');
        expect(host).toContain('font-src data:');
        expect(host).toContain('media-src data: blob:');
        expect(host).toContain('sandbox="allow-scripts"');
        expect(host.includes(source)).toBe(false);
        expect(host.match(/<\/script>/gi)).toHaveLength(1);
    });
});
