// Shared by all pickers and the send boundary; configuration is a per-session operation.
const pending = new Set<string>();
const listeners = new Set<() => void>();
export const isAgyConfigPending = (sessionId: string) => pending.has(sessionId);
export const subscribeAgyConfig = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function beginAgyConfig(sessionId: string): boolean {
    if (pending.has(sessionId)) return false;
    pending.add(sessionId);
    listeners.forEach(listener => listener());
    return true;
}
export function finishAgyConfig(sessionId: string) {
    pending.delete(sessionId);
    listeners.forEach(listener => listener());
}
