import { useEffect } from 'react';
import { Platform } from 'react-native';
import { isTauri } from '@/utils/isTauri';

export const DEFAULT_APP_ZOOM = 0.75;

const MIN_APP_ZOOM = 0.5;
const MAX_APP_ZOOM = 2.5;
const WEB_ZOOM_CLASS = 'happy-app-zoomed';

const clampZoom = (zoom: number) => Math.max(MIN_APP_ZOOM, Math.min(MAX_APP_ZOOM, zoom));

// Cmd/Ctrl+=, Cmd/Ctrl+-, Cmd/Ctrl+0 zoom shortcuts for the Tauri desktop app.
// Uses Tauri's native webview.setZoom — unlike CSS `zoom`, this shrinks the
// layout viewport so matchMedia / window.innerWidth change and responsive
// breakpoints (unistyles etc.) react correctly.
export function useTauriZoom() {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') return;

        const inTauri = isTauri();
        const root = document.documentElement;

        if (!inTauri) {
            root.style.setProperty('--happy-app-zoom', String(DEFAULT_APP_ZOOM));
            root.classList.add(WEB_ZOOM_CLASS);
            return () => {
                root.classList.remove(WEB_ZOOM_CLASS);
                root.style.removeProperty('--happy-app-zoom');
            };
        }

        root.classList.remove(WEB_ZOOM_CLASS);
        root.style.removeProperty('--happy-app-zoom');

        let zoom = DEFAULT_APP_ZOOM;
        let webview: { setZoom: (z: number) => Promise<void> } | null = null;

        const apply = (z: number) => {
            zoom = clampZoom(z);
            webview?.setZoom(zoom).catch((e) => console.error('setZoom failed:', e));
        };

        (async () => {
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            webview = getCurrentWebview();
            apply(zoom);
        })();

        const onKey = (e: KeyboardEvent) => {
            if ((!e.metaKey && !e.ctrlKey) || e.altKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                apply(zoom + 0.1);
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                apply(zoom - 0.1);
            } else if (e.key === '0') {
                e.preventDefault();
                apply(DEFAULT_APP_ZOOM);
            }
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}
