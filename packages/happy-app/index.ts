/**
 * App entry. In a Tauri build, we read the user's CLI config (~/.happy/
 * settings.json + ~/.happy/access.key) and seed `window.__HAPPY_CONFIG__` +
 * `localStorage.auth_credentials` BEFORE the React bundle starts, so the
 * desktop app picks up the user's self-hosted server + identity automatically
 * — no in-app "Server URL" entry, no localStorage injection dance.
 *
 * Everywhere else (browser web build, native mobile), this fast-path is a
 * no-op (no __TAURI_INTERNALS__), and the existing config resolution chain
 * (MMKV → __HAPPY_CONFIG__ → cluster-fluster default) runs as before.
 */

async function bootHappy() {
    if (
        typeof window !== 'undefined' &&
        (window as any).__TAURI_INTERNALS__ !== undefined
    ) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const cfg = await invoke<{
                server_url?: string;
                webapp_url?: string;
                auth?: { token: string; secret: string };
            }>('read_happy_config');

            if (cfg?.server_url) {
                (globalThis as any).__HAPPY_CONFIG__ = {
                    ...(globalThis as any).__HAPPY_CONFIG__,
                    serverUrl: cfg.server_url,
                };
            }
            if (cfg?.auth && typeof localStorage !== 'undefined') {
                // Don't clobber an existing in-app session — only seed if empty.
                if (!localStorage.getItem('auth_credentials')) {
                    localStorage.setItem('auth_credentials', JSON.stringify(cfg.auth));
                }
            }
        } catch (e) {
            // Tauri command absent (e.g. older shell) or files unreadable —
            // fall through to default config resolution.
            console.warn('[happy-bootstrap] Tauri config read skipped:', e);
        }
    }

    await import('./sources/polyfills/screenOrientation');
    await import('./sources/unistyles');
    // @ts-ignore — expo-router/entry has no type declaration but exists at runtime
    await import('expo-router/entry');
}

bootHappy();
