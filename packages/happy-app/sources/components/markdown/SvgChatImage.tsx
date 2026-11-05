/**
 * Inline renderer for an SVG chat image (native: iOS / Android).
 *
 * react-native-svg parses some attribute values in NATIVE code at draw time and
 * throws there on anything it does not understand. On Android that is an
 * exception on the UI thread inside `SvgView.onDraw`, out of reach of any JS
 * error boundary, so a single chat message can take the whole app down. It did:
 * an `orient="auto-start-reverse"` arrowhead killed the app with a
 * `NumberFormatException` out of `MarkerView.renderMarker`, measured on an
 * emulator against react-native-svg 15.12.1.
 *
 * The markup is never handed over raw: `sanitizeSvgMarkup` rewrites the
 * constructs the native parser refuses, and that needs the markup in JS first.
 * A remote `.svg` is fetched here for that reason, since `SvgUri` fetches and
 * parses it natively, where the payload cannot be seen or fixed.
 *
 * The same string gives the SVG's own proportions (`parseSvgIntrinsicSize`) at
 * no extra cost, so the chat can size the box the way it sizes a raster image.
 */
import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './svgImageSource';
import { sanitizeSvgMarkup } from './sanitizeSvgMarkup';
import { parseSvgIntrinsicSize, type SvgIntrinsicSize } from './svgIntrinsicSize';

/**
 * Remote SVGs are fetched once per URL and kept, so scrolling a long chat back
 * and forth does not refetch the same diagram on every remount. Bounded because
 * this holds decoded markup: a chat can accumulate many images over a session.
 */
const MAX_CACHED = 24;
const cache = new Map<string, string>();

function remember(uri: string, xml: string) {
    if (cache.has(uri)) cache.delete(uri);
    cache.set(uri, xml);
    while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/**
 * A diagram is markup, so it is small; anything this large is not something we
 * want to hold decoded in memory, nor hand to a renderer that lays out every
 * element as a native draw op.
 */
const MAX_BYTES = 2 * 1024 * 1024;

interface SvgChatImageProps {
    uri: string;
    accessibilityLabel: string;
    /** Reports the SVG's own proportions once the markup is in hand, so the
     *  caller can size the box the way it sizes a raster image. */
    onIntrinsicSize?: (size: SvgIntrinsicSize) => void;
}

export function SvgChatImage({ uri, accessibilityLabel, onIntrinsicSize }: SvgChatImageProps) {
    const source = React.useMemo(() => parseSvgImageSource(uri), [uri]);

    // Inline markup needs no fetch. Sanitize it and it is ready on the first
    // render, with no empty frame in between.
    const inlineXml = React.useMemo(() => {
        if (!source || source.kind !== 'xml') return null;
        try {
            return sanitizeSvgMarkup(source.xml);
        } catch {
            return null;
        }
    }, [source]);

    const [fetchedXml, setFetchedXml] = React.useState<string | null>(() =>
        source && source.kind === 'uri' ? cache.get(source.uri) ?? null : null,
    );

    React.useEffect(() => {
        if (!source || source.kind !== 'uri') return;
        const cached = cache.get(source.uri);
        if (cached !== undefined) {
            setFetchedXml(cached);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(source.uri);
                if (!res.ok) throw new Error(`svg fetch ${res.status}`);
                const declared = Number(res.headers.get('content-length') ?? '0');
                if (declared > MAX_BYTES) throw new Error('svg too large');
                const text = await res.text();
                if (text.length > MAX_BYTES) throw new Error('svg too large');
                const xml = sanitizeSvgMarkup(text);
                remember(source.uri, xml);
                if (!cancelled) setFetchedXml(xml);
            } catch {
                // A diagram that cannot be fetched, or is too big, stays an empty
                // box, which is what the user saw before any of this existed.
                // Never fall back to handing the raw source to the native
                // renderer: that is the crash this component exists to prevent.
                if (!cancelled) setFetchedXml(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [source]);

    const xml = inlineXml ?? fetchedXml;

    // The markup is already here, so the size costs one parse and no second
    // load. It is reported from an effect, because reporting during render
    // would move the parent's layout mid-render.
    React.useEffect(() => {
        if (!xml || !onIntrinsicSize) return;
        const size = parseSvgIntrinsicSize(xml);
        if (size) onIntrinsicSize(size);
    }, [xml, onIntrinsicSize]);

    if (!xml) {
        return <View accessible accessibilityLabel={accessibilityLabel} />;
    }
    return (
        <View accessible accessibilityLabel={accessibilityLabel} style={{ flex: 1 }}>
            <SvgXml xml={xml} width="100%" height="100%" />
        </View>
    );
}
