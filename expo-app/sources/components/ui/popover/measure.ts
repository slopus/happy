import { Platform } from 'react-native';
import type { PopoverWindowRect } from './_types';

export function measureInWindow(node: any): Promise<PopoverWindowRect | null> {
    return new Promise(resolve => {
        try {
            if (!node) return resolve(null);

            const measureDomRect = (candidate: any): PopoverWindowRect | null => {
                const el: any =
                    typeof candidate?.getBoundingClientRect === 'function'
                        ? candidate
                        : candidate?.getScrollableNode?.();
                if (!el || typeof el.getBoundingClientRect !== 'function') return null;
                const rect = el.getBoundingClientRect();
                const x = rect?.left ?? rect?.x;
                const y = rect?.top ?? rect?.y;
                const width = rect?.width;
                const height = rect?.height;
                if (![x, y, width, height].every(n => Number.isFinite(n))) return null;
                // Treat 0x0 rects as invalid: on iOS (and occasionally RN-web), refs can report 0x0
                // for a frame while layout settles. Using these values causes menus to overlap the
                // trigger and prevents subsequent recomputes from correcting placement.
                if (width <= 0 || height <= 0) return null;
                return { x, y, width, height };
            };

            // On web, prefer DOM measurement. It's synchronous and avoids cases where
            // RN-web's `measureInWindow` returns invalid values or never calls back.
            if (Platform.OS === 'web') {
                const rect = measureDomRect(node);
                if (rect) return resolve(rect);
            }

            // On native, `measure` can provide pageX/pageY values that are sometimes more reliable
            // than `measureInWindow` when using react-native-screens (modal/drawer presentations).
            // Prefer it when available.
            if (Platform.OS !== 'web' && typeof node.measure === 'function') {
                node.measure((x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
                    if (![pageX, pageY, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        return resolve(null);
                    }
                    resolve({ x: pageX, y: pageY, width, height });
                });
                return;
            }

            if (typeof node.measureInWindow === 'function') {
                node.measureInWindow((x: number, y: number, width: number, height: number) => {
                    if (![x, y, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        if (Platform.OS === 'web') {
                            const rect = measureDomRect(node);
                            if (rect) return resolve(rect);
                        }
                        return resolve(null);
                    }
                    resolve({ x, y, width, height });
                });
                return;
            }

            if (Platform.OS === 'web') return resolve(measureDomRect(node));

            resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export function measureLayoutRelativeTo(node: any, relativeToNode: any): Promise<PopoverWindowRect | null> {
    return new Promise(resolve => {
        try {
            if (!node || !relativeToNode) return resolve(null);
            if (typeof node.measureLayout !== 'function') return resolve(null);
            node.measureLayout(
                relativeToNode,
                (x: number, y: number, width: number, height: number) => {
                    if (![x, y, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        resolve(null);
                        return;
                    }
                    resolve({ x, y, width, height });
                },
                () => resolve(null),
            );
        } catch {
            resolve(null);
        }
    });
}

export function getFallbackBoundaryRect(params: { windowWidth: number; windowHeight: number }): PopoverWindowRect {
    // On native, the "window" coordinate space is the best available fallback.
    // On web, this maps closely to the viewport (measureInWindow is viewport-relative).
    return { x: 0, y: 0, width: params.windowWidth, height: params.windowHeight };
}

