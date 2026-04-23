import { useEffect } from 'react';
import { isTauri } from '@/utils/isTauri';

// Cmd+= / Cmd+- / Cmd+0 zoom shortcuts for the Tauri macOS app.
// Uses Tauri's native webview.setZoom — unlike CSS `zoom`, this shrinks the
// layout viewport so matchMedia / window.innerWidth change and responsive
// breakpoints (unistyles etc.) react correctly.
export function useTauriZoom() {
    useEffect(() => {
        if (!isTauri()) return;

        let zoom = 1;
        let webview: { setZoom: (z: number) => Promise<void> } | null = null;

        (async () => {
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            webview = getCurrentWebview();
        })();

        const apply = (z: number) => {
            zoom = Math.max(0.5, Math.min(2.5, z));
            webview?.setZoom(zoom).catch((e) => console.error('setZoom failed:', e));
        };

        const onKey = (e: KeyboardEvent) => {
            if (!e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                apply(zoom + 0.1);
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                apply(zoom - 0.1);
            } else if (e.key === '0') {
                e.preventDefault();
                apply(1);
            }
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}
