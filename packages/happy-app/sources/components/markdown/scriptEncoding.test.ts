import { describe, expect, it } from 'vitest';
import { jsonForScriptElement } from './scriptEncoding';

describe('jsonForScriptElement', () => {
    it('produces a value the script receives unchanged', () => {
        const content = 'graph TD;\n  A["a < b"] --> B;';
        expect(JSON.parse(jsonForScriptElement(content))).toBe(content);
    });

    it('never emits a sequence that closes the surrounding script element', () => {
        const payload = 'graph TD;</script><img src=x onerror=alert(1)>';
        const encoded = jsonForScriptElement(payload);

        expect(encoded.toLowerCase()).not.toContain('</script');
        // The diagram body still reaches mermaid byte for byte.
        expect(JSON.parse(encoded)).toBe(payload);
    });

    it('is exactly what JSON.stringify alone fails to provide', () => {
        // The defect this module fixes: a JavaScript-string encoder leaves the
        // closing sequence intact, and the HTML tokenizer acts on it first.
        expect(JSON.stringify('</script>').toLowerCase()).toContain('</script');
    });

    it('escapes a closing tag whatever its case', () => {
        expect(jsonForScriptElement('</ScRiPt >').toLowerCase()).not.toContain('</script');
    });

    it('escapes the line separators JSON allows raw but JavaScript does not', () => {
        const encoded = jsonForScriptElement('a\u2028b\u2029c');

        expect(encoded).not.toContain('\u2028');
        expect(encoded).not.toContain('\u2029');
        expect(JSON.parse(encoded)).toBe('a\u2028b\u2029c');
    });
});
