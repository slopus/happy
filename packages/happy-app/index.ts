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
                // Treat the CLI as the source of truth for *this machine's*
                // identity. We used to only write when localStorage was empty,
                // which left users stuck on a stale token from a previous
                // registration (e.g. when first set up against the public
                // server, then switched to self-host via .env). The mismatched
                // JWT 401s on every request and the loading spinner spins
                // forever — overwrite when the JWT subject differs.
                const incoming = JSON.stringify(cfg.auth);
                const existing = localStorage.getItem('auth_credentials');
                let shouldWrite = !existing;
                if (existing && !shouldWrite) {
                    try {
                        const existingSub = JSON.parse(atob(JSON.parse(existing).token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
                        const incomingSub = JSON.parse(atob(cfg.auth.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
                        shouldWrite = existingSub !== incomingSub;
                    } catch {
                        // Can't parse → existing creds are corrupt, replace them
                        shouldWrite = true;
                    }
                }
                if (shouldWrite) {
                    localStorage.setItem('auth_credentials', incoming);
                }
            }
        })
        .catch((e) => {
            console.warn('[happy-bootstrap] Tauri config read skipped:', e);
        });
}

import 'expo-router/entry';
