/**
 * Inline SVG chat image on web.
 *
 * The native file next to this one fetches and rewrites the markup because
 * react-native-svg parses it in Java/ObjC and throws there on anything it does
 * not implement, killing the process. On web there is no such parser: the
 * markup reaches the browser's own SVG engine, which implements the whole spec
 * and renders what native cannot.
 *
 * A remote `.svg` is handed to the browser as an ORDINARY IMAGE. `SvgUri` would
 * fetch the file to inline it (`react-native-svg/src/xml.tsx`), and a
 * cross-origin `fetch` needs the server to send
 * `Access-Control-Allow-Origin`, which an image host has no reason to do.
 * Measured: remote diagrams were empty boxes on web ("blocked by CORS policy"
 * in the console) and rendered as soon as the header was added to a test
 * server. Loading them the way the browser loads any image needs no header from
 * anyone, so an SVG posted from any origin renders.
 *
 * A data URI keeps the inline path: there is nothing to fetch, so CORS does not
 * apply, and it draws the same way as on native.
 */
import * as React from 'react';
import { Image, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { parseSvgImageSource } from './svgImageSource';
import { isDefaultObjectSize, parseSvgIntrinsicSize, type SvgIntrinsicSize } from './svgIntrinsicSize';

interface SvgChatImageProps {
    uri: string;
    accessibilityLabel: string;
    /** Reports the SVG's own proportions, so the caller can size the box the
     *  way it sizes a raster image. */
    onIntrinsicSize?: (size: SvgIntrinsicSize) => void;
}

export function SvgChatImage({ uri, accessibilityLabel, onIntrinsicSize }: SvgChatImageProps) {
    const source = React.useMemo(() => parseSvgImageSource(uri), [uri]);

    // Inline markup can be read directly; a remote file is left to the browser
    // (see the note above), so its size comes from `Image.getSize`, which on
    // web loads the SVG in a DOM <img> and reports the size the browser
    // computed. That needs no CORS headers. It is measured pixels, so the image
    // may be capped at it, unless the SVG states no size of its own and the
    // browser reported its default object size instead (`isDefaultObjectSize`):
    // then only the ratio is known, as with a viewBox.
    React.useEffect(() => {
        if (!source || !onIntrinsicSize) return;
        if (source.kind === 'xml') {
            const size = parseSvgIntrinsicSize(source.xml);
            if (size) onIntrinsicSize(size);
            return;
        }
        let cancelled = false;
        Image.getSize(
            source.uri,
            (width, height) => {
                if (cancelled || !width || !height) return;
                onIntrinsicSize({ width, height, fromViewBox: isDefaultObjectSize(width, height) });
            },
            () => {
                // Unreachable image: the caller keeps its placeholder ratio.
            },
        );
        return () => { cancelled = true; };
    }, [source, onIntrinsicSize]);

    if (!source) {
        return <View accessible accessibilityLabel={accessibilityLabel} />;
    }
    return (
        <View accessible accessibilityLabel={accessibilityLabel} style={{ flex: 1 }}>
            {source.kind === 'xml' ? (
                <SvgXml xml={source.xml} width="100%" height="100%" />
            ) : (
                <Image
                    source={{ uri: source.uri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="contain"
                />
            )}
        </View>
    );
}
