/**
 * Polyfill for `screen.orientation` — react-native-web (and some expo modules)
 * read `screen.orientation.type` at module-load time. Tauri on certain Linux
 * setups (X11 fallback, software GL, disabled DMA-BUF) ships a WebKit build
 * where `screen.orientation` is undefined, which crashes the bundle before
 * React even mounts.
 *
 * Web-only; native platforms have their own AppState/Dimensions stack.
 * Imported first from index.ts so it runs before any module that touches the API.
 */

if (typeof window !== 'undefined' && typeof screen !== 'undefined') {
    const s = screen as unknown as { orientation?: { type: string; angle: number; addEventListener?: Function; removeEventListener?: Function } };
    if (!s.orientation) {
        const stub = {
            type: 'landscape-primary',
            angle: 0,
            addEventListener: () => { },
            removeEventListener: () => { },
            dispatchEvent: () => false,
        };
        try {
            Object.defineProperty(screen, 'orientation', {
                value: stub,
                writable: false,
                configurable: true,
            });
        } catch {
            // Fallback if defineProperty fails: assign directly
            (screen as unknown as { orientation: typeof stub }).orientation = stub;
        }
    }
}
