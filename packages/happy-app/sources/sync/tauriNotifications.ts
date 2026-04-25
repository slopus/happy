import { isTauri } from '@/utils/platform';

const DEDUP_WINDOW_MS = 5000;

// Track last notification time per session for dedup
const lastNotificationTime = new Map<string, number>();

let tauriInvoke: ((cmd: string, args?: any) => Promise<any>) | null = null;

async function getInvoke() {
    if (!isTauri()) return null;
    if (!tauriInvoke) {
        const { invoke } = await import('@tauri-apps/api/core');
        tauriInvoke = invoke;
    }
    return tauriInvoke;
}

// Security: notification body must NOT contain chat message content.
// Use only session name and action type.
export async function sendDesktopNotification(
    title: string,
    body: string,
    sessionId?: string,
    route?: string,
) {
    // Suppress when window is focused
    if (typeof document !== 'undefined' && document.hasFocus()) {
        return;
    }

    // Dedup: skip if same session notified within 5s
    if (sessionId) {
        const lastTime = lastNotificationTime.get(sessionId) ?? 0;
        const now = Date.now();
        if (now - lastTime < DEDUP_WINDOW_MS) {
            return;
        }
        lastNotificationTime.set(sessionId, now);
    }

    const invoke = await getInvoke();
    if (!invoke) return;

    try {
        await invoke('send_notification', { title, body, route: route ?? null });
    } catch (e) {
        console.warn('[notifications] Failed to send desktop notification:', e);
    }
}

// Hook for sync update handlers — routes update types to appropriate notifications
export function onSyncUpdate(
    updateType: string,
    data: { sessionId?: string; sessionName?: string; agentState?: any; active?: boolean },
) {
    if (!isTauri()) return;

    switch (updateType) {
        case 'update-session':
            if (data.agentState != null) {
                void sendDesktopNotification(
                    'Permission request',
                    `${data.sessionName ?? 'Session'} needs your approval`,
                    data.sessionId,
                    data.sessionId ? `/session/${data.sessionId}` : undefined,
                );
            }
            // Session completed (active → false)
            if (data.active === false) {
                void sendDesktopNotification(
                    'Session completed',
                    `${data.sessionName ?? 'Session'} has finished`,
                    data.sessionId,
                    data.sessionId ? `/session/${data.sessionId}` : undefined,
                );
            }
            break;

        case 'relationship-updated':
            void sendDesktopNotification(
                'Friend request',
                'You have a new friend request',
            );
            break;
    }
}

// Exported for testing
export { DEDUP_WINDOW_MS, lastNotificationTime };
