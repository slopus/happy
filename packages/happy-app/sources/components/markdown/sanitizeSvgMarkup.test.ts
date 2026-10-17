import { describe, it, expect } from 'vitest';
import { sanitizeSvgMarkup } from './sanitizeSvgMarkup';

/**
 * The value under test is what react-native-svg's NATIVE renderer receives.
 * `orient="auto-start-reverse"` reaching it is a process kill on Android
 * (NumberFormatException out of SvgView.onDraw), so "does the output still
 * contain that string" is the assertion that matters most here.
 */
const MARKER = (orient: string, id = 'g') =>
    `<marker id="${id}" viewBox="0 0 10 8" refX="9" refY="4" orient="${orient}"><path d="M0,0 L10,4 L0,8Z"/></marker>`;

const doc = (defs: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;

/** Every `orient` value on a `<marker>` in `xml`, in document order. */
const orientsIn = (xml: string) =>
    [...xml.matchAll(/<marker\b[^>]*?\borient="([^"]*)"/g)].map((m) => m[1]);

/**
 * Whether a marker's `orient` survives the Android renderer, following the path
 * it takes in react-native-svg 15.12.1: xml.tsx:461 coerces a numeric-looking
 * attribute value with `+value`, Marker.tsx:57 hands `String(orient)` to the
 * native view, and MarkerView.java:125 then evaluates
 *
 *   "auto".equals(mOrient) ? -1 : Double.parseDouble(mOrient)
 *
 * `true` means that line would not throw. `Double.parseDouble` ignores
 * characters up to U+0020 around the value and takes an optional sign, then
 * NaN, Infinity, or decimal digits with an optional fraction, exponent and
 * f/F/d/D suffix (hexadecimal floats are left out: nothing here produces them).
 */
function androidAcceptsOrient(attribute: string): boolean {
    const delivered = !isNaN(+attribute) && attribute.trim() !== '' ? String(+attribute) : attribute;
    if (delivered === 'auto') return true;
    return /^[\u0000- ]*[+-]?(NaN|Infinity|((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?))[\u0000- ]*$/.test(delivered);
}

describe('sanitizeSvgMarkup', () => {
    it('leaves markup with no marker untouched', () => {
        const xml = '<svg><path d="M0 0 L10 10"/></svg>';
        expect(sanitizeSvgMarkup(xml)).toBe(xml);
    });

    it('leaves a valid orient untouched', () => {
        for (const orient of ['auto', '0', '45', '-90.5', '1e2', '.5']) {
            const xml = doc(MARKER(orient), '<path marker-end="url(#g)"/>');
            expect(sanitizeSvgMarkup(xml)).toBe(xml);
        }
    });

    it('rewrites auto-start-reverse to auto', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path d="M0 0" marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).toContain('orient="auto"');
    });

    it('does not add a clone when the marker is only an end marker', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out.match(/<marker\b/g)).toHaveLength(1);
        expect(out).toContain('marker-end="url(#g)"');
    });

    it('emits a 180-rotated clone and repoints marker-start', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-start="url(#g)" marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out.match(/<marker\b/g)).toHaveLength(2);
        expect(out).toContain('id="g-happy-start-reverse"');
        expect(out).toContain('<g transform="rotate(180 9 4)">');
        // start goes to the rotated clone, end stays on the original
        expect(out).toContain('marker-start="url(#g-happy-start-reverse)"');
        expect(out).toContain('marker-end="url(#g)"');
        expect(out).not.toContain('auto-start-reverse"');
    });

    it('falls back to the initial value 0 for an unparseable orient', () => {
        const xml = doc(MARKER('sideways'), '<path marker-end="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).toContain('orient="0"');
        expect(out).not.toContain('sideways');
    });

    it('rejects a number the native parser would also reject', () => {
        // parseFloat would accept "12px"; Double.parseDouble does not.
        const out = sanitizeSvgMarkup(doc(MARKER('12px'), '<path marker-end="url(#g)"/>'));
        expect(out).toContain('orient="0"');
    });

    it('rewrites a padded auto, which Android compares exactly', () => {
        // `"auto".equals(" auto ")` is false, so the padded keyword reaches
        // Double.parseDouble like any other string and throws.
        for (const orient of [' auto', 'auto ', ' auto ', '\tauto', 'auto ', ' auto']) {
            const out = sanitizeSvgMarkup(doc(MARKER(orient), '<path marker-end="url(#g)"/>'));
            expect(orientsIn(out), JSON.stringify(orient)).toEqual(['auto']);
        }
    });

    it('handles several markers independently', () => {
        const xml = doc(
            MARKER('auto-start-reverse', 'a') + MARKER('auto', 'b') + MARKER('nonsense', 'c'),
            '<path marker-end="url(#a)"/><path marker-end="url(#b)"/><path marker-end="url(#c)"/>',
        );
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).not.toContain('nonsense');
        expect(out.match(/orient="auto"/g)).toHaveLength(2);
        expect(out).toContain('orient="0"');
    });

    it('leaves a self-closing marker parseable', () => {
        const xml = doc('<marker id="g" refX="1" refY="2" orient="auto-start-reverse"/>', '<path marker-start="url(#g)"/>');
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        // No children to rotate, so no clone is invented.
        expect(out.match(/<marker\b/g)).toHaveLength(1);
    });

    it('does not touch an unterminated marker element', () => {
        const xml = '<svg><defs><marker id="g" orient="auto-start-reverse"><path/></defs></svg>';
        expect(sanitizeSvgMarkup(xml)).toBe(xml);
    });

    it('accepts single-quoted attributes', () => {
        const xml = "<svg><defs><marker id='g' refX='9' refY='4' orient='auto-start-reverse'><path/></marker></defs><path marker-end='url(#g)'/></svg>";
        const out = sanitizeSvgMarkup(xml);
        expect(out).not.toContain('auto-start-reverse');
        expect(out).toContain('orient="auto"');
    });

    it('is idempotent', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-start="url(#g)"/>');
        const once = sanitizeSvgMarkup(xml);
        expect(sanitizeSvgMarkup(once)).toBe(once);
    });

    it('handles the diagram that actually crashed the app', () => {
        // Shape of the diagram that killed the Android app inside
        // MarkerView.renderMarker: four auto-start-reverse markers, referenced
        // only as marker-end.
        const defs = ['g', 'r', 'o', 'd'].map((id) => MARKER('auto-start-reverse', id)).join('');
        const body = '<path marker-end="url(#g)"/><path marker-end="url(#r)"/><path marker-end="url(#o)"/><path marker-end="url(#d)"/>';
        const out = sanitizeSvgMarkup(doc(defs, body));
        expect(out).not.toContain('auto-start-reverse');
        expect(out.match(/<marker\b/g)).toHaveLength(4);
        expect(out.match(/orient="auto"/g)).toHaveLength(4);
    });
});

describe('sanitizeSvgMarkup against the Android orient parser', () => {
    it('models the parser: the crashing inputs are rejected, the safe ones accepted', () => {
        // If the model accepted `auto-start-reverse` the checks below would prove nothing.
        expect(androidAcceptsOrient('auto-start-reverse')).toBe(false);
        expect(androidAcceptsOrient(' auto ')).toBe(false);
        expect(androidAcceptsOrient('12px')).toBe(false);
        expect(androidAcceptsOrient('')).toBe(false);
        expect(androidAcceptsOrient('auto')).toBe(true);
        expect(androidAcceptsOrient('45')).toBe(true);
        expect(androidAcceptsOrient(' 45 ')).toBe(true);
    });

    it('turns auto-start-reverse into an orient Android accepts, and still reverses the start marker', () => {
        const xml = doc(MARKER('auto-start-reverse'), '<path marker-start="url(#g)" marker-end="url(#g)"/>');
        // The input is the crash...
        expect(orientsIn(xml).every(androidAcceptsOrient)).toBe(false);

        const out = sanitizeSvgMarkup(xml);
        // ...the output is two markers, both accepted.
        const orients = orientsIn(out);
        expect(orients).toHaveLength(2);
        expect(orients.every(androidAcceptsOrient)).toBe(true);

        // The reversal survives: the start reference points at a marker whose
        // content is turned 180 degrees about the reference point, and the end
        // reference still points at the untouched original.
        const startId = /marker-start="url\(#([^)]+)\)"/.exec(out)?.[1];
        const endId = /marker-end="url\(#([^)]+)\)"/.exec(out)?.[1];
        expect(startId).toBeDefined();
        expect(endId).toBeDefined();
        expect(startId).not.toBe(endId);
        const body = (id: string | undefined) =>
            new RegExp(`<marker\\b[^>]*\\bid="${id}"[^>]*>(.*?)</marker>`).exec(out)?.[1];
        expect(body(startId)).toContain('rotate(180 9 4)');
        expect(body(endId)).not.toContain('rotate(');
    });

    it('leaves no orient Android would reject, whatever the input', () => {
        const inputs = [
            'auto', 'auto-start-reverse', ' auto-start-reverse ', ' auto ', 'auto ', ' auto',
            'AUTO', '', ' ', '12px', '12deg', 'sideways', 'inherit', 'none', '1,5', '1e', '--1',
            '0', '45', ' 45 ', '-90.5', '+5', '1e2', '.5', '5.', '0x10', 'NaN', 'Infinity',
        ];
        for (const orient of inputs) {
            const out = sanitizeSvgMarkup(doc(MARKER(orient), '<path marker-start="url(#g)" marker-end="url(#g)"/>'));
            for (const value of orientsIn(out)) {
                expect(androidAcceptsOrient(value), `orient=${JSON.stringify(orient)} became ${JSON.stringify(value)}`).toBe(true);
            }
        }
    });
});
