/**
 * App entry. In a Tauri build, we read the user's CLI config (~/.happy/
 * settings.json + ~/.happy/access.key) and seed `window.__HAPPY_CONFIG__` +
 * `localStorage.auth_credentials` so the desktop app launches against the
 * self-hosted server with the user's identity.
 *
 * The bootstrap is exposed as `globalThis.__HAPPY_TAURI_BOOTSTRAP__`; RootLayout
 * awaits it before reading credentials / connecting the socket. Without that
 * await, syncRestore() raced the bootstrap, called getServerUrl() before the
 * Tauri-supplied URL landed, and connected to the public default server —
 * which 401s for self-hosted accounts and leaves the UI spinning forever.
 *
 * We still don't `await` the bootstrap at module scope: dynamic-importing
 * 'expo-router/entry' behind the same await caused Metro's web bundler to
 * ship a never-resolving chunk (white screen). The promise pattern keeps the
 * React tree statically importable while letting the layout effect block on
 * config readiness.
 */

import './sources/polyfills/screenOrientation';
import './sources/unistyles';

declare global {
    var __HAPPY_TAURI_BOOTSTRAP__: Promise<void> | undefined;
}

if (
    typeof window !== 'undefined' &&
    (window as any).__TAURI_INTERNALS__ !== undefined
) {
    (globalThis as any).__HAPPY_TAURI_BOOTSTRAP__ = import('@tauri-apps/api/core')
        .then(({ invoke }) =>
            invoke<{
                server_url?: string;
                webapp_url?: string;
                auth?: { token: string; secret: string };
            }>('read_happy_config')
        )
        .then((cfg) => {
            if (cfg?.server_url) {
                (globalThis as any).__HAPPY_CONFIG__ = {
                    ...((globalThis as any).__HAPPY_CONFIG__ ?? {}),
                    serverUrl: cfg.server_url,
                };
            }
            if (cfg?.auth && typeof localStorage !== 'undefined') {
                if (!localStorage.getItem('auth_credentials')) {
                    localStorage.setItem('auth_credentials', JSON.stringify(cfg.auth));
                }
            }
        })
        .catch((e) => {
            console.warn('[happy-bootstrap] Tauri config read skipped:', e);
        });
}

import 'expo-router/entry';
