import * as React from 'react';

const query = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

function mediaQuery(): MediaQueryList | null {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query)
        : null;
}

function subscribe(listener: () => void): () => void {
    const media = mediaQuery();
    if (!media) return () => {};
    if (media.addEventListener) {
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
    }
    media.addListener(listener);
    return () => media.removeListener(listener);
}

export function useReducedTransparency(): boolean {
    return React.useSyncExternalStore(subscribe, () => !!mediaQuery()?.matches, () => false);
}
