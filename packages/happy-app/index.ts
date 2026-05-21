/**
 * App entry. In a Tauri build, we read the user's CLI config (~/.happy/
 * settings.json + ~/.happy/access.key) and seed `window.__HAPPY_CONFIG__` +
 * `localStorage.auth_credentials` so the desktop app launches against the
 * self-hosted server with the user's identity.
 *
 * The Tauri read is fire-and-forget *in parallel* with React boot — using
 * await on it (or dynamic-importing expo-router/entry behind it) caused
 * Metro's web bundler to ship a never-resolving promise, leaving a blank
 * white screen. With the parallel pattern: the seed lands within ~50ms (Tauri
 * invoke is fast), well before serverConfig.ts is touched for the first
 * authenticated API call.
 */

import './sources/polyfills/screenOrientation';
import './sources/unistyles';

if (
    typeof window !== 'undefined' &&
    (window as any).__TAURI_INTERNALS__ !== undefined
) {
    import('@tauri-apps/api/core')
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
        .catch((e) => console.warn('[happy-bootstrap] Tauri config read skipped:', e));
}

import 'expo-router/entry';
