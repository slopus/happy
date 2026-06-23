import * as React from 'react';
import type { ApiEphemeralSessionEventUpdate } from './apiTypes';

const TOAST_TTL_MS = 60_000;
const MAX_VISIBLE_TOASTS = 3;

export type SessionEventToast = ApiEphemeralSessionEventUpdate & {
    id: string;
    expiresAt: number;
};

let snapshot: SessionEventToast[] = [];
const listeners = new Set<() => void>();

function emitChange() {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot() {
    return snapshot;
}

export function pushSessionEventToast(event: ApiEphemeralSessionEventUpdate) {
    const id = `${event.sessionId}:${event.kind}:${event.timestamp}`;
    const toast: SessionEventToast = {
        ...event,
        id,
        expiresAt: Date.now() + TOAST_TTL_MS,
    };

    snapshot = [
        toast,
        ...snapshot.filter((item) => item.sessionId !== event.sessionId),
    ].slice(0, MAX_VISIBLE_TOASTS);
    emitChange();
}

export function dismissSessionEventToast(id: string) {
    const next = snapshot.filter((toast) => toast.id !== id);
    if (next.length === snapshot.length) {
        return;
    }
    snapshot = next;
    emitChange();
}

export function useSessionEventToasts() {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
