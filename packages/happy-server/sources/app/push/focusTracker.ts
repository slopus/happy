/**
 * Tracks mobile app focus state per socket connection.
 * Used by push dispatch to suppress notifications when the app is in foreground.
 * Per-process in-memory state — cross-replica focus is not tracked;
 * the client-side notification handler drops pushes when the app is foreground.
 */

type AppFocusState = 'active' | 'background';

const focusState = new Map<string, AppFocusState>();

export function setFocusState(socketId: string, state: AppFocusState): void {
    focusState.set(socketId, state);
}

export function clearFocusState(socketId: string): void {
    focusState.delete(socketId);
}

export function isForeground(socketId: string): boolean {
    return focusState.get(socketId) === 'active';
}
