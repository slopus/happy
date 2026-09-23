/**
 * Encode a value for interpolation inside an HTML `<script>` element.
 *
 * `JSON.stringify` is a JavaScript-string encoder, not an HTML one. The HTML
 * tokenizer ends a script element at the first case-insensitive `</script`,
 * whatever the JavaScript string state it appears in, so a value carrying that
 * sequence closes the element early and everything after it is parsed as
 * markup. Escaping `<` prevents the sequence from ever being produced while
 * leaving the value identical once parsed, because `<` is `<` inside a
 * JavaScript string literal.
 *
 * U+2028 and U+2029 are escaped for the same reason in reverse: JSON allows
 * them raw, and older JavaScript parsers treat them as line terminators.
 */
export function jsonForScriptElement(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
