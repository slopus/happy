// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createMermaidImageUri } from './mermaidSvgImage';

describe('createMermaidImageUri', () => {
    it('preserves Mermaid Chinese HTML labels and line breaks as valid standalone SVG', () => {
        const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 1800"><style>.label{color:#abc}</style><foreignObject width="200" height="80"><div xmlns="http://www.w3.org/1999/xhtml"><p>澄清目标<br>范围 &amp; 标准&nbsp;完成</p></div></foreignObject></svg>';
        const uri = createMermaidImageUri(raw);
        const serialized = decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
        const parsed = new DOMParser().parseFromString(serialized, 'image/svg+xml');

        expect(parsed.querySelector('parsererror')).toBeNull();
        expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 400 1800');
        // A downloaded image must retain the original dimensions, independent of thumbnail size.
        expect(parsed.documentElement.getAttribute('width')).toBe('400');
        expect(parsed.documentElement.getAttribute('height')).toBe('1800');
        expect(parsed.querySelector('p')?.textContent).toBe('澄清目标范围 & 标准\u00a0完成');
        expect(parsed.querySelector('br')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
        expect(parsed.querySelector('style')?.textContent).toBe('.label{color:#abc}');
    });
});
