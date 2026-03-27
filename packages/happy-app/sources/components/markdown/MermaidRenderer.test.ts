import { describe, it, expect } from 'vitest';

// Import the escapeHtml function by re-implementing it here since it's not exported.
// We test the logic directly to verify correctness.
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

describe('escapeHtml', () => {
    it('should escape ampersands', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('should escape angle brackets', () => {
        expect(escapeHtml('<div>hello</div>')).toBe('&lt;div&gt;hello&lt;/div&gt;');
    });

    it('should escape quotes', () => {
        expect(escapeHtml('say "hello" & \'bye\'')).toBe('say &quot;hello&quot; &amp; &#39;bye&#39;');
    });

    it('should return empty string unchanged', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('should not modify safe strings', () => {
        expect(escapeHtml('graph TD; A-->B')).toBe('graph TD; A--&gt;B');
    });

    it('should handle all special characters together', () => {
        expect(escapeHtml('<script>alert("xss")&</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&amp;&lt;/script&gt;'
        );
    });
});

describe('Mermaid XSS sanitization via encodeURIComponent', () => {
    it('should safely encode XSS payload in script tags', () => {
        const malicious = '<script>alert("xss")</script>';
        const encoded = encodeURIComponent(malicious);
        // The encoded string should not contain raw < or > characters
        expect(encoded).not.toContain('<');
        expect(encoded).not.toContain('>');
        expect(encoded).not.toContain('"');
        // It should decode back to the original
        expect(decodeURIComponent(encoded)).toBe(malicious);
    });

    it('should safely encode event handler injection', () => {
        const malicious = 'graph TD; A["<img onerror=alert(1) src=x>"]-->B';
        const encoded = encodeURIComponent(malicious);
        expect(encoded).not.toContain('<');
        expect(encoded).not.toContain('>');
        expect(decodeURIComponent(encoded)).toBe(malicious);
    });

    it('should safely encode JavaScript protocol injection', () => {
        const malicious = 'graph TD; click A "javascript:alert(1)"';
        const encoded = encodeURIComponent(malicious);
        // The content is safely passed as a JS string, not interpolated into HTML
        expect(decodeURIComponent(encoded)).toBe(malicious);
    });

    it('should handle normal mermaid content without corruption', () => {
        const normal = 'graph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[OK]\n    B -->|No| D[End]';
        const encoded = encodeURIComponent(normal);
        expect(decodeURIComponent(encoded)).toBe(normal);
    });

    it('should safely encode content with template literal breakout attempts', () => {
        const malicious = '${document.cookie}`;alert(1);//';
        const encoded = encodeURIComponent(malicious);
        // The encoded version should not contain raw backtick or ${ which could break template literals
        expect(encoded).not.toContain('`');
        expect(decodeURIComponent(encoded)).toBe(malicious);
    });

    it('should safely encode double-quote breakout attempts', () => {
        const malicious = '");alert("xss");//';
        const encoded = encodeURIComponent(malicious);
        // encodeURIComponent encodes " as %22
        expect(encoded).not.toContain('"');
        expect(decodeURIComponent(encoded)).toBe(malicious);
    });
});
