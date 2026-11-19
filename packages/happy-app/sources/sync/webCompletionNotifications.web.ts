import { router } from 'expo-router';
import { getCurrentLanguage } from '@/text';
import { getSessionName } from '@/utils/sessionUtils';
import { storage } from './storage';

export type BrowserNotificationPermission = NotificationPermission | 'unsupported' | 'insecure';

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    return Notification.permission;
}

/** Must be called directly from a user gesture, never from the state listener. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
    const permission = getBrowserNotificationPermission();
    if (permission !== 'default') return permission;
    try {
        return await Notification.requestPermission();
    } catch {
        return getBrowserNotificationPermission();
    }
}

function showNotification(title: string, body: string, tag: string, sessionId?: string): boolean {
    if (getBrowserNotificationPermission() !== 'granted') return false;
    try {
        const notification = new Notification(title, { body, tag });
        notification.onclick = () => {
            window.focus();
            if (sessionId) router.push(`/session/${encodeURIComponent(sessionId)}` as any);
            notification.close();
        };
        return true;
    } catch {
        return false;
    }
}

export function previewBrowserNotification(): boolean {
    const chinese = getCurrentLanguage().startsWith('zh');
    return showNotification(
        chinese ? 'Paws · 测试通知' : 'Paws · Test notification',
        chinese ? '任务完成时，你会在这里收到提醒。' : 'You will be notified here when a task completes.',
        'paws-completion-test',
    );
}

const claimStorageKey = 'paws:web-completion-notifications';
const claimed = new Set<string>();
const pending = new Set<string>();
const maxClaims = 300;

function readClaims(): string[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(claimStorageKey) ?? '[]');
        return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(-maxClaims) : [];
    } catch {
        return [];
    }
}

function notifyCompletion(sessionId: string, key: string, body: string): void {
    if (pending.has(key) || claimed.has(key)) return;
    pending.add(key);
    const send = () => {
        if (!storage.getState().localSettings.webCompletionNotificationsEnabled || claimed.has(key) || readClaims().includes(key)) return;
        const title = getCurrentLanguage().startsWith('zh') ? 'Paws · 任务已完成' : 'Paws · Task completed';
        if (!showNotification(title, body, `paws-completed:${key}`, sessionId)) return;
        claimed.add(key);
        if (claimed.size > maxClaims) claimed.delete(claimed.values().next().value!);
        try {
            localStorage.setItem(claimStorageKey, JSON.stringify([...readClaims(), key].slice(-maxClaims)));
        } catch {
            // Memory and the browser's notification tag still suppress duplicates.
        }
    };
    const finish = () => pending.delete(key);
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        void navigator.locks.request('paws-web-completion-notification', send)
            .catch(() => { send(); }).finally(finish);
    } else {
        try { send(); } finally { finish(); }
    }
}

let listening = false;

/** Completion follows the persisted outcome, not the generic "ready" event. */
export function startWebCompletionNotifications(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    storage.subscribe((next, previous) => {
        if (!next.isDataReady || !previous.isDataReady || !next.localSettings.webCompletionNotificationsEnabled) return;
        for (const [id, session] of Object.entries(next.sessions)) {
            const prior = previous.sessions[id];
            if (!prior || session === prior) continue;
            const turn = session.agentState?.turnStatus;
            const previousTurn = prior.agentState?.turnStatus;
            if (turn?.status !== 'completed') continue;
            // A newly hydrated idle shell is not an observed task completing.
            if (!previousTurn && prior.thinking !== true) continue;
            // Presence/thinking can expose an OLD completion in the UI. Only a
            // new durable outcome counts; a reconnect may skip the running UI.
            if (previousTurn?.status === 'completed'
                && previousTurn.turnId === turn.turnId
                && previousTurn.updatedAt === turn.updatedAt) continue;
            const key = `${id}:${turn?.turnId ?? ''}:${turn?.updatedAt ?? session.activeAt ?? session.updatedAt}`;
            notifyCompletion(id, key, getSessionName(session));
        }
    });
}
