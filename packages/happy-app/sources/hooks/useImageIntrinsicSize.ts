/**
 * Resolves a remote image's intrinsic pixel size, so a caller can lay the image
 * out at its own aspect ratio instead of inside a fixed-size box.
 *
 * Sizes are kept in a module-level LRU (max 200) that is read synchronously
 * during render. The chat is a virtualized list, so a row scrolled out of view
 * and back in remounts this hook; without the cache every remount would
 * re-measure and the layout would jump again each time.
 *
 * Measurement uses the CALLBACK form of `Image.getSize` deliberately:
 *  - react-native's types also expose a Promise overload, but react-native-web
 *    only implements the callback form (`ImageWithStatics.getSize` in
 *    react-native-web/dist/exports/Image/index.js), so an awaited call never
 *    settles on web.
 *  - `<Image onLoad>` is not usable either: react-native reports
 *    `nativeEvent.source.{width,height}`, while react-native-web forwards the
 *    raw DOM event (react-native-web/dist/modules/ImageLoader/index.js), so the
 *    dimensions are undefined there.
 *
 * `Image.getSize` populates the same image cache the subsequent `<Image>` reads
 * from, so measuring does not cost an extra network fetch in practice.
 */
import * as React from 'react';
import { Image } from 'react-native';

export type ImageIntrinsicSize = { width: number; height: number };

const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, ImageIntrinsicSize>();

function rememberInCache(url: string, size: ImageIntrinsicSize) {
    if (cache.has(url)) cache.delete(url);
    cache.set(url, size);
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
}

export function useImageIntrinsicSize(url: string | null): ImageIntrinsicSize | null {
    const [resolved, setResolved] = React.useState<{ url: string, size: ImageIntrinsicSize } | null>(null);

    React.useEffect(() => {
        if (!url || cache.has(url)) {
            return;
        }
        let cancelled = false;
        Image.getSize(
            url,
            (width, height) => {
                if (cancelled || !width || !height) {
                    return;
                }
                const size = { width, height };
                rememberInCache(url, size);
                setResolved({ url, size });
            },
            () => {
                // Unreachable image: leave the caller on its placeholder ratio.
            }
        );
        return () => { cancelled = true; };
    }, [url]);

    if (!url) {
        return null;
    }
    const cached = cache.get(url);
    if (cached) {
        return cached;
    }
    return resolved && resolved.url === url ? resolved.size : null;
}
