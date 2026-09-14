import { decodeBase64 } from '@/encryption/base64';
import { decodeUTF8 } from '@/encryption/text';

const SVG_DATA_PREFIX = 'data:image/svg+xml';

export type SvgImageSource =
    | { kind: 'xml'; xml: string }
    | { kind: 'uri'; uri: string };

/**
 * Parse a markdown image URL into a renderable SVG source, or `null` if it is
 * not an SVG (caller then falls back to RN's `<Image>`).
 *
 * RN's core `<Image>` cannot decode SVG on native (iOS/Android) — it only
 * renders raster formats — so SVG markdown images render blank on phones while
 * working on web. Routing SVG through `react-native-svg` (`SvgXml`/`SvgUri`)
 * fixes that on every platform.
 *
 *  - `data:image/svg+xml;base64,…`            → `{ kind: 'xml' }` (decoded markup)
 *  - `data:image/svg+xml;utf8,…` / `,<enc>`   → `{ kind: 'xml' }` (decoded markup)
 *  - `https://…/x.svg` (or any `.svg` path)   → `{ kind: 'uri' }` (passthrough)
 *  - anything else (png/jpg/data:image/png…)  → `null`
 */
export function parseSvgImageSource(url: string): SvgImageSource | null {
    const trimmed = url.trim();

    if (trimmed.toLowerCase().startsWith(SVG_DATA_PREFIX)) {
        const comma = trimmed.indexOf(',');
        if (comma === -1) {
            return null;
        }
        const meta = trimmed.slice(SVG_DATA_PREFIX.length, comma).toLowerCase();
        const data = trimmed.slice(comma + 1);

        let xml: string;
        if (meta.includes(';base64')) {
            try {
                xml = decodeUTF8(decodeBase64(data.trim()));
            } catch {
                return null;
            }
        } else {
            // `;utf8,` or a percent-encoded payload — `decodeURIComponent`
            // throws on a stray `%`, in which case the data is already raw.
            try {
                xml = decodeURIComponent(data);
            } catch {
                xml = data;
            }
        }

        xml = xml.trim();
        return xml ? { kind: 'xml', xml } : null;
    }

    // Remote or local `.svg` file — ignore any query string / hash fragment.
    const pathOnly = trimmed.split(/[?#]/, 1)[0].toLowerCase();
    if (pathOnly.endsWith('.svg')) {
        return { kind: 'uri', uri: trimmed };
    }

    return null;
}

/** True if the markdown image URL points at an SVG (data URI or `.svg`). */
export function isSvgImageUrl(url: string): boolean {
    return parseSvgImageSource(url) !== null;
}
