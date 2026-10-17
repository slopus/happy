/**
 * Make chat-supplied SVG markup safe for react-native-svg's NATIVE renderers.
 *
 * react-native-svg hands some attribute values straight to Java/ObjC number
 * parsing at DRAW time, with no guard. On Android `Double.parseDouble` then
 * throws out of `SvgView.onDraw`, which is a native exception on the UI thread:
 * no JS error boundary can catch it, and the app process dies. Measured on an
 * emulator against react-native-svg 15.12.1: a diagram whose arrowheads use
 * SVG 2's `orient="auto-start-reverse"` killed the app with
 *
 *   java.lang.NumberFormatException: For input string: "auto-start-reverse"
 *     at com.horcrux.svg.MarkerView.renderMarker(MarkerView.java:125)
 *     at com.horcrux.svg.SvgView.onDraw(SvgView.java:135)
 *
 * Line 125 is `"auto".equals(mOrient) ? -1 : Double.parseDouble(mOrient)`, and
 * 15.16.0 (the latest release when this was written) still has it, so bumping
 * the dependency does not help. This module rewrites the markup so the native
 * parser never sees a value it would throw on. Because it runs in JS, it
 * applies on every installed native build, whichever react-native-svg version
 * that build carries.
 *
 * Each rewrite keeps the picture's meaning:
 *
 *  - `orient="auto-start-reverse"` becomes `orient="auto"`. That is exactly
 *    equivalent wherever the marker is used as `marker-mid`/`marker-end`. Where
 *    it is used as `marker-start` — the one case where SVG 2 asks for a further
 *    180° — a rotated clone of the marker is emitted and the `marker-start`
 *    reference is repointed at it, which expresses the same picture in SVG 1.1.
 *  - the keyword `auto` is compared exactly on Android (`"auto".equals`), so a
 *    padded ` auto ` throws like any other unparseable value; it is rewritten to
 *    `auto`.
 *  - any other unparseable `orient` becomes `0`, the property's initial value,
 *    which is what a compliant renderer does with an invalid value.
 *
 * Padding around a NUMBER is harmless: react-native-svg's XML parser coerces a
 * numeric-looking attribute value with `+value` before it reaches native code,
 * so only the keyword arrives untrimmed.
 */

/** A marker element located in the source, with the bits we need to rewrite it. */
interface MarkerElement {
    /** index of the `<` that opens the element */
    start: number;
    /** index just past the element's final `>` */
    end: number;
    /** index just past the opening tag's `>` (== `end` when self-closing) */
    openEnd: number;
    /** index of the `<` that opens `</marker>` (== `openEnd` when self-closing) */
    innerEnd: number;
    /** the raw opening tag, e.g. `<marker id="g" orient="auto-start-reverse">` */
    openTag: string;
    id: string | null;
    orient: string | null;
    refX: string;
    refY: string;
    selfClosing: boolean;
}

const OPEN_MARKER = /<marker\b([^>]*?)(\/?)>/gi;
const CLOSE_MARKER = /<\/marker\s*>/gi;

/** Read `name="value"` / `name='value'` out of a tag's attribute text. */
function attr(tag: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tag);
    if (!m) return null;
    return (m[2] !== undefined ? m[2] : m[3]) ?? null;
}

/**
 * SVG's `<number>`: an optional sign, digits with an optional fraction, and an
 * optional exponent. Deliberately stricter than `parseFloat`, which stops at
 * the first bad character and would call `12px` valid. The native parser does
 * not, and it is the native parser we are protecting.
 */
const SVG_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function isSvgNumber(value: string): boolean {
    return SVG_NUMBER.test(value.trim());
}

/** Locate every `<marker>` element in document order. */
function findMarkers(xml: string): MarkerElement[] {
    const out: MarkerElement[] = [];
    OPEN_MARKER.lastIndex = 0;
    let open: RegExpExecArray | null;
    while ((open = OPEN_MARKER.exec(xml)) !== null) {
        const openTag = open[0];
        const attrs = open[1] ?? '';
        const selfClosing = open[2] === '/';
        const openEnd = open.index + openTag.length;

        let innerEnd = openEnd;
        let end = openEnd;
        if (!selfClosing) {
            CLOSE_MARKER.lastIndex = openEnd;
            const close = CLOSE_MARKER.exec(xml);
            // An unterminated <marker> is malformed markup, and where it ends
            // is a guess, so the rest of the document is left alone.
            if (!close) break;
            innerEnd = close.index;
            end = close.index + close[0].length;
        }

        out.push({
            start: open.index,
            end,
            openEnd,
            innerEnd,
            openTag,
            id: attr(attrs, 'id'),
            orient: attr(attrs, 'orient'),
            refX: attr(attrs, 'refX') ?? '0',
            refY: attr(attrs, 'refY') ?? '0',
            selfClosing,
        });
        OPEN_MARKER.lastIndex = end;
    }
    return out;
}

/**
 * The ids referenced by `marker-start`, as a presentation attribute or inside a
 * `style="…"` declaration. `marker="url(#x)"` sets all three positions, so it
 * counts as a start reference too.
 */
function startReferencedIds(xml: string): Set<string> {
    const ids = new Set<string>();
    const re = /\bmarker(?:-start)?\s*[:=]\s*["']?\s*url\(\s*['"]?#([^'")\s]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        // `marker-end`/`marker-mid` also match `marker` above only if the regex
        // allowed the suffix, and it does not, so this is start-or-shorthand only.
        ids.add(m[1]);
    }
    return ids;
}

function setOrient(openTag: string, value: string): string {
    return openTag.replace(
        /\borient\s*=\s*("[^"]*"|'[^']*')/i,
        `orient="${value}"`,
    );
}

function setId(openTag: string, value: string): string {
    return openTag.replace(/\bid\s*=\s*("[^"]*"|'[^']*')/i, `id="${value}"`);
}

/**
 * Rewrite `marker-start="url(#from)"` (and the `marker=` shorthand's start
 * position) to point at `to`, leaving `marker-mid`/`marker-end` alone.
 */
function repointStart(xml: string, from: string, to: string): string {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return xml.replace(
        new RegExp(
            `(\\bmarker-start\\s*[:=]\\s*["']?\\s*url\\(\\s*['"]?#)${escaped}(?=['")\\s])`,
            'gi',
        ),
        `$1${to}`,
    );
}

/**
 * Return `xml` with every value react-native-svg's native renderer would refuse
 * to parse replaced by an equivalent it accepts.
 *
 * Pure and total: any markup that is not an SVG, or that this cannot make sense
 * of, comes back unchanged, never half-rewritten.
 */
export function sanitizeSvgMarkup(xml: string): string {
    if (!xml || xml.indexOf('<marker') === -1) {
        return xml;
    }

    const markers = findMarkers(xml);
    if (markers.length === 0) {
        return xml;
    }

    const startRefs = startReferencedIds(xml);
    // id -> the clone that carries the extra 180°, filled in below.
    const repoint: Array<{ from: string; to: string }> = [];

    // Rebuild the document, replacing marker elements back to front is
    // unnecessary here because we assemble it in one pass from the pieces.
    let out = '';
    let cursor = 0;

    for (const marker of markers) {
        out += xml.slice(cursor, marker.start);
        cursor = marker.end;

        const orient = marker.orient;
        const element = xml.slice(marker.start, marker.end);

        // Exactly what Android's `"auto".equals(...) / parseDouble(...)` lets through.
        if (orient === null || orient === 'auto' || isSvgNumber(orient)) {
            out += element;
            continue;
        }

        const keyword = orient.trim();
        if (keyword !== 'auto-start-reverse') {
            // A padded `auto` still means auto. Anything else is invalid per SVG:
            // a compliant renderer falls back to the initial value, and Android
            // would instead throw out of onDraw.
            out += setOrient(marker.openTag, keyword === 'auto' ? 'auto' : '0') + xml.slice(marker.openEnd, marker.end);
            continue;
        }

        const fixed = setOrient(marker.openTag, 'auto') + xml.slice(marker.openEnd, marker.end);
        out += fixed;

        // SVG 2: `auto-start-reverse` differs from `auto` only for a marker in
        // the START position, which is rotated a further 180°. Express that in
        // SVG 1.1 as a second marker whose content is pre-rotated about the
        // reference point, and send the start reference there.
        if (!marker.id || !startRefs.has(marker.id) || marker.selfClosing) {
            continue;
        }
        const cloneId = `${marker.id}-happy-start-reverse`;
        const inner = xml.slice(marker.openEnd, marker.innerEnd);
        const rotate = `<g transform="rotate(180 ${marker.refX} ${marker.refY})">${inner}</g>`;
        out += setId(setOrient(marker.openTag, 'auto'), cloneId) + rotate + '</marker>';
        repoint.push({ from: marker.id, to: cloneId });
    }

    out += xml.slice(cursor);

    for (const { from, to } of repoint) {
        out = repointStart(out, from, to);
    }
    return out;
}
