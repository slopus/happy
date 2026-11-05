/**
 * Reads an SVG's own size out of its markup, so an inline diagram can be laid
 * out at its real proportions.
 *
 * A raster image is measured with `Image.getSize`, which cannot help here: on
 * native, RN's `<Image>` does not decode SVG at all, so the callback never
 * fires. The size is in the markup, though, and by the time anything is drawn
 * the markup is already in JS (SvgChatImage fetches it to sanitize it), so
 * parsing it costs nothing extra.
 *
 * Two sources, in the order SVG itself specifies:
 *  - `width`/`height` on the root element, when both are absolute lengths.
 *    Those are the intrinsic size, and a caller may cap display at them the way
 *    it caps a raster image at its pixel size.
 *  - otherwise `viewBox`, which fixes the RATIO but says nothing about how big
 *    the picture wants to be. `fromViewBox` marks that, so a caller does not
 *    mistake user units for pixels and refuse to scale the image up.
 */
export type SvgIntrinsicSize = {
    width: number;
    height: number;
    /** True when only the ratio is known: width/height are user units (a viewBox)
     *  or a browser's default size (`isDefaultObjectSize`). */
    fromViewBox: boolean;
};

/** Absolute lengths only: a unitless number or `px`. A percentage sizes against
 *  the parent and an em/pt/cm depends on a font or a DPI we do not have, so
 *  those are treated as "not stated" and the viewBox answers instead. */
function absoluteLength(value: string | undefined): number | null {
    if (!value) return null;
    const m = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function rootAttributes(markup: string): Record<string, string> | null {
    // The root tag only: a nested <svg> or a <symbol> must not answer for the
    // document, and neither must an attribute inside a comment before it.
    const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, '');
    const open = /<svg\b([^>]*)>/i.exec(withoutComments);
    if (!open) return null;
    const attrs: Record<string, string> = {};
    const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(open[1])) !== null) {
        attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] ?? '');
    }
    return attrs;
}

export function parseSvgIntrinsicSize(markup: string): SvgIntrinsicSize | null {
    const attrs = rootAttributes(markup);
    if (!attrs) return null;

    const width = absoluteLength(attrs.width);
    const height = absoluteLength(attrs.height);
    if (width !== null && height !== null) {
        return { width, height, fromViewBox: false };
    }

    const viewBox = attrs.viewbox;
    if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
            const [, , vbWidth, vbHeight] = parts;
            if (vbWidth > 0 && vbHeight > 0) {
                return { width: vbWidth, height: vbHeight, fromViewBox: true };
            }
        }
    }
    return null;
}

/**
 * Whether a size a browser measured for an SVG file is only the browser's
 * default object size. An SVG that states no size of its own (a viewBox only,
 * or percentages) has no intrinsic size, so the browser reports 300 wide or 150
 * high, whichever fits, in the picture's ratio. Measured in Chrome: 267x150
 * for a 16:9 viewBox, 300x75 for 4:1, 75x150 for 1:2. Those pixels carry the
 * ratio and nothing else, exactly like a viewBox.
 *
 * An SVG that really is 300 wide or 150 high, inside that 300x150 box, reads
 * the same way. The cost is only that it is not held to its declared size.
 */
export function isDefaultObjectSize(width: number, height: number): boolean {
    const w = Math.round(width);
    const h = Math.round(height);
    return w <= 300 && h <= 150 && (w === 300 || h === 150);
}
