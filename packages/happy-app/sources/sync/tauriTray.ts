import { isTauri } from '@/utils/platform';

interface TraySession {
    id: string;
    name: string;
}

// Format sessions for tray menu: max 5, sorted by most recent activity
export function formatTrayStatus(
    online: boolean,
    sessions: Array<{ id: string; name: string; activeAt: number }>
): { online: boolean; sessions: TraySession[] } {
    const sorted = [...sessions]
        .sort((a, b) => b.activeAt - a.activeAt)
        .slice(0, 5)
        .map(s => ({ id: s.id, name: s.name }));
    return { online, sessions: sorted };
}

let tauriInvoke: ((cmd: string, args?: any) => Promise<any>) | null = null;
let tauriListen: ((event: string, handler: (e: any) => void) => Promise<() => void>) | null = null;

// Lazy-load Tauri APIs to avoid import errors on non-Tauri platforms
async function getTauriAPIs() {
    if (!isTauri()) return null;
    if (!tauriInvoke) {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        tauriInvoke = invoke;
        tauriListen = listen;
    }
    return { invoke: tauriInvoke!, listen: tauriListen! };
}

// Update tray icon menu with current status and sessions
export async function updateTrayStatus(
    online: boolean,
    sessions: Array<{ id: string; name: string; activeAt: number }>
) {
    const apis = await getTauriAPIs();
    if (!apis) return;

    const { online: o, sessions: s } = formatTrayStatus(online, sessions);
    try {
        await apis.invoke('update_tray_status', { online: o, sessions: s });
    } catch (e) {
        console.warn('[tray] Failed to update tray status:', e);
    }
}

// Listen for tray menu actions and route navigation
export async function listenTrayActions(
    onNavigate: (sessionId: string) => void,
    onNewSession: () => void,
): Promise<(() => void) | null> {
    const apis = await getTauriAPIs();
    if (!apis) return null;

    const unlisten = await apis.listen('tray-action', (event: any) => {
        const payload = event.payload as { action: string; sessionId?: string };
        switch (payload.action) {
            case 'navigate':
                if (payload.sessionId) {
                    onNavigate(payload.sessionId);
                }
                break;
            case 'new-session':
                onNewSession();
                break;
        }
    });

    return unlisten;
}
